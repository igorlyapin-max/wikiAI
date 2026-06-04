from __future__ import annotations

import os
import time
from functools import lru_cache
from typing import Any

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from qdrant_client import QdrantClient, models
from transformers import AutoModel, AutoTokenizer


DEFAULT_MODEL = "antoinelouis/colbert-xm"
DEFAULT_COLLECTION = "wiki_colbert_chunks"


def env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value and value.strip() else default


QDRANT_URL = env("QDRANT_URL", "http://qdrant:6333")
COLBERT_MODEL = env("COLBERT_MODEL", DEFAULT_MODEL)
COLBERT_COLLECTION = env("COLBERT_COLLECTION", DEFAULT_COLLECTION)
COLBERT_DEVICE = env("COLBERT_DEVICE", "cpu")
COLBERT_MAX_TOKENS = int(env("COLBERT_MAX_TOKENS", "180"))

app = FastAPI(title="WikiAI ColBERT service")
qdrant = QdrantClient(url=QDRANT_URL)


class ChunkInput(BaseModel):
    id: int
    text: str
    chunkIndex: int = 0
    totalChunks: int = 1
    sourceType: str | None = None
    attachmentFilename: str | None = None
    mimeType: str | None = None
    processingMode: str | None = None
    contentType: str | None = None


class PageIndexRequest(BaseModel):
    model: str = COLBERT_MODEL
    collection: str = COLBERT_COLLECTION
    pageId: int
    title: str
    namespace: int
    allowedGroups: list[str] = Field(default_factory=lambda: ["*"])
    lastModified: str | None = None
    replacePage: bool = True
    chunks: list[ChunkInput]


class DeletePageRequest(BaseModel):
    collection: str = COLBERT_COLLECTION
    pageId: int


class SearchRequest(BaseModel):
    query: str
    model: str = COLBERT_MODEL
    collection: str = COLBERT_COLLECTION
    topK: int = 20


class RerankCandidate(BaseModel):
    id: int
    title: str | None = None
    text: str


class RerankRequest(BaseModel):
    query: str
    model: str = COLBERT_MODEL
    topK: int = 20
    candidates: list[RerankCandidate]


class ColbertEncoder:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name)
        self.model.to(COLBERT_DEVICE)
        self.model.eval()
        self.vector_size = int(self.model.config.hidden_size)

    def encode(self, texts: list[str]) -> list[np.ndarray]:
        if not texts:
            return []
        with torch.inference_mode():
            encoded = self.tokenizer(
                texts,
                padding=True,
                truncation=True,
                max_length=COLBERT_MAX_TOKENS,
                return_tensors="pt",
                return_special_tokens_mask=True,
            )
            inputs = {
                key: value.to(COLBERT_DEVICE)
                for key, value in encoded.items()
                if key != "special_tokens_mask"
            }
            output = self.model(**inputs).last_hidden_state.detach().cpu().numpy()
            attention = encoded["attention_mask"].cpu().numpy().astype(bool)
            special = encoded["special_tokens_mask"].cpu().numpy().astype(bool)

        vectors: list[np.ndarray] = []
        for index, matrix in enumerate(output):
            token_mask = attention[index] & ~special[index]
            selected = matrix[token_mask]
            if selected.size == 0:
                selected = matrix[attention[index]]
            selected = normalize_rows(selected.astype(np.float32))
            vectors.append(selected)
        return vectors


def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return matrix / norms


@lru_cache(maxsize=4)
def get_encoder(model_name: str) -> ColbertEncoder:
    return ColbertEncoder(model_name)


def ensure_collection(collection: str, vector_size: int) -> None:
    collections = qdrant.get_collections().collections
    if any(item.name == collection for item in collections):
        return
    qdrant.create_collection(
        collection_name=collection,
        vectors_config=models.VectorParams(
            size=vector_size,
            distance=models.Distance.COSINE,
            multivector_config=models.MultiVectorConfig(
                comparator=models.MultiVectorComparator.MAX_SIM,
            ),
        ),
    )
    for field_name, schema in [
        ("page_id", models.PayloadSchemaType.INTEGER),
        ("namespace", models.PayloadSchemaType.INTEGER),
        ("allowed_groups", models.PayloadSchemaType.KEYWORD),
    ]:
        qdrant.create_payload_index(
            collection_name=collection,
            field_name=field_name,
            field_schema=schema,
        )


def page_filter(page_id: int) -> models.Filter:
    return models.Filter(
        must=[
            models.FieldCondition(
                key="page_id",
                match=models.MatchValue(value=page_id),
            )
        ]
    )


def point_to_result(point: Any) -> dict[str, Any]:
    payload = point.payload or {}
    return {
        "id": int(point.id),
        "score": float(point.score),
        "pageId": payload.get("page_id"),
        "title": payload.get("title"),
        "text": payload.get("text"),
        "namespace": payload.get("namespace"),
        "allowedGroups": payload.get("allowed_groups") or ["*"],
        "chunkIndex": payload.get("chunk_index"),
        "totalChunks": payload.get("total_chunks"),
        "lastModified": payload.get("last_modified"),
        "sourceType": payload.get("source_type"),
        "attachmentFilename": payload.get("attachment_filename"),
        "attachmentMime": payload.get("attachment_mime"),
        "attachmentProcessingMode": payload.get("attachment_processing_mode"),
        "contentType": payload.get("content_type"),
        "payload": payload,
    }


def maxsim_score(query_vectors: np.ndarray, doc_vectors: np.ndarray) -> float:
    if query_vectors.size == 0 or doc_vectors.size == 0:
        return 0.0
    similarities = np.matmul(query_vectors, doc_vectors.T)
    return float(np.max(similarities, axis=1).sum() / max(len(query_vectors), 1))


@app.get("/health")
def health() -> dict[str, Any]:
    started_at = time.time()
    collection_status: dict[str, Any]
    try:
        collection = qdrant.get_collection(COLBERT_COLLECTION)
        collection_status = {
            "exists": True,
            "points": collection.points_count,
            "vectors": collection.vectors_count,
        }
    except Exception as exc:  # noqa: BLE001 - health should report, not crash
        collection_status = {"exists": False, "error": str(exc)}
    return {
        "status": "ok",
        "model": COLBERT_MODEL,
        "collection": COLBERT_COLLECTION,
        "qdrantUrl": QDRANT_URL,
        "device": COLBERT_DEVICE,
        "modelCache": get_encoder.cache_info()._asdict(),
        "collectionStatus": collection_status,
        "latencyMs": int((time.time() - started_at) * 1000),
    }


@app.post("/index/page")
def index_page(request: PageIndexRequest) -> dict[str, Any]:
    encoder = get_encoder(request.model)
    ensure_collection(request.collection, encoder.vector_size)
    if request.replacePage:
        qdrant.delete(
            collection_name=request.collection,
            points_selector=models.FilterSelector(filter=page_filter(request.pageId)),
        )

    vectors = encoder.encode([chunk.text for chunk in request.chunks])
    points = []
    for chunk, vector in zip(request.chunks, vectors, strict=True):
        if not chunk.text.strip():
            continue
        payload = {
            "page_id": request.pageId,
            "title": request.title,
            "namespace": request.namespace,
            "text": chunk.text,
            "allowed_groups": request.allowedGroups or ["*"],
            "chunk_index": chunk.chunkIndex,
            "total_chunks": chunk.totalChunks,
            "last_modified": request.lastModified,
            "source_type": chunk.sourceType or "page",
            "attachment_filename": chunk.attachmentFilename,
            "attachment_mime": chunk.mimeType,
            "attachment_processing_mode": chunk.processingMode,
            "content_type": chunk.contentType,
        }
        points.append(
            models.PointStruct(
                id=chunk.id,
                vector=vector.tolist(),
                payload=payload,
            )
        )

    if points:
        qdrant.upsert(collection_name=request.collection, points=points)
    return {"status": "ok", "collection": request.collection, "chunks": len(points)}


@app.post("/index/delete-page")
def delete_page(request: DeletePageRequest) -> dict[str, Any]:
    qdrant.delete(
        collection_name=request.collection,
        points_selector=models.FilterSelector(filter=page_filter(request.pageId)),
    )
    return {"status": "ok", "collection": request.collection, "pageId": request.pageId}


@app.post("/search")
def search(request: SearchRequest) -> dict[str, Any]:
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="query is required")
    encoder = get_encoder(request.model)
    ensure_collection(request.collection, encoder.vector_size)
    query_vectors = encoder.encode([request.query])[0].tolist()
    result = qdrant.query_points(
        collection_name=request.collection,
        query=query_vectors,
        limit=max(1, min(int(request.topK), 200)),
        with_payload=True,
    )
    points = getattr(result, "points", result)
    return {
        "status": "ok",
        "collection": request.collection,
        "model": request.model,
        "results": [point_to_result(point) for point in points],
    }


@app.post("/rerank")
def rerank(request: RerankRequest) -> dict[str, Any]:
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="query is required")
    encoder = get_encoder(request.model)
    query_vectors = encoder.encode([request.query])[0]
    doc_vectors = encoder.encode([candidate.text for candidate in request.candidates])
    ranked = [
        {
            "id": candidate.id,
            "score": maxsim_score(query_vectors, vector),
        }
        for candidate, vector in zip(request.candidates, doc_vectors, strict=True)
    ]
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return {
        "status": "ok",
        "model": request.model,
        "results": ranked[: max(1, min(int(request.topK), 200))],
    }
