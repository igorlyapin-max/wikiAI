#!/usr/bin/env python3
"""Generate three WikiAI PPTX decks using only Python stdlib."""

from __future__ import annotations

import argparse
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape


SLIDE_W = 12_192_000
SLIDE_H = 6_858_000
EMU_PER_INCH = 914_400


@dataclass(frozen=True)
class Slide:
    title: str
    thesis: str
    bullets: tuple[str, ...]
    visual: str


@dataclass(frozen=True)
class Style:
    key: str
    label: str
    filename: str
    bg: str
    fg: str
    muted: str
    accent: str
    accent2: str
    soft: str
    line: str
    footer: str


STYLES = (
    Style(
        key="executive",
        label="Совет ИТ",
        filename="wikiai-executive-it-board.pptx",
        bg="FFFFFF",
        fg="111827",
        muted="4B5563",
        accent="7C3AED",
        accent2="059669",
        soft="F5F3FF",
        line="E5E7EB",
        footer="374151",
    ),
    Style(
        key="architecture",
        label="Архитектурный",
        filename="wikiai-architecture.pptx",
        bg="F8FAFC",
        fg="111827",
        muted="475569",
        accent="0F766E",
        accent2="7C3AED",
        soft="ECFDF5",
        line="CBD5E1",
        footer="334155",
    ),
    Style(
        key="product",
        label="Продуктовый",
        filename="wikiai-product.pptx",
        bg="FFFBEB",
        fg="111827",
        muted="57534E",
        accent="D97706",
        accent2="7C3AED",
        soft="FEF3C7",
        line="FED7AA",
        footer="44403C",
    ),
)


TECH_WHITELIST = {
    "WikiAI",
    "PPTX",
    "MediaWiki",
    "AI",
    "RAG",
    "LLM",
    "Qdrant",
    "LiteLLM",
    "ColBERT",
    "BM25",
    "FTS",
    "FTS5",
    "SSE",
    "OIDC",
    "MCP",
    "API",
    "webhook",
    "cookie",
    "namespace",
    "Redis",
    "SQLite",
    "Postgres",
    "Nginx",
    "Docker",
    "Compose",
    "CI",
    "Gateway",
    "Syncer",
    "SMW",
    "Semantic",
    "OpenAI",
    "Ollama",
    "vLLM",
    "OCR",
    "File",
    "ACL",
    "DR",
    "BCP",
    "RPO",
    "RTO",
    "MIME",
    "UI",
    "LDAP",
    "FAQ",
    "PDF",
    "SLA",
    "sysop",
    "aiadmin",
    "dryRun",
    "hybrid",
    "text",
    "ocr",
    "metadata",
    "disabled",
    "Embedding",
    "embeddings",
}


def emu(value: float) -> int:
    return int(value * EMU_PER_INCH)


def x(text: str) -> str:
    return escape(text, {'"': "&quot;"})


def parse_slides(path: Path) -> list[Slide]:
    lines = path.read_text(encoding="utf-8").splitlines()
    slides: list[Slide] = []
    current_title: str | None = None
    thesis = ""
    bullets: list[str] = []
    visual = ""

    def flush() -> None:
        nonlocal current_title, thesis, bullets, visual
        if current_title is None:
            return
        slides.append(Slide(current_title, thesis, tuple(bullets), visual))
        current_title = None
        thesis = ""
        bullets = []
        visual = ""

    for raw in lines:
        line = raw.strip()
        match = re.match(r"^###\s+\d+\.\s+(.+)$", line)
        if match:
            flush()
            current_title = match.group(1).strip()
            continue
        if current_title is None:
            continue
        if line.startswith("Тезис:"):
            thesis = line.replace("Тезис:", "", 1).strip()
        elif line.startswith("- "):
            bullets.append(line[2:].strip())
        elif line.startswith("Визуал:"):
            visual = line.replace("Визуал:", "", 1).strip()
    flush()

    if not slides:
        raise ValueError(f"No slides found in {path}")
    return slides


def solid_fill(color: str) -> str:
    return f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'


def no_fill() -> str:
    return "<a:noFill/>"


def line(color: str, width: int = 12_000) -> str:
    return f'<a:ln w="{width}">{solid_fill(color)}</a:ln>'


def paragraph(
    text: str,
    *,
    size: int,
    color: str,
    bold: bool = False,
    bullet: bool = False,
    align: str | None = None,
) -> str:
    ppr_parts: list[str] = []
    if align:
        ppr_parts.append(f'algn="{align}"')
    ppr_attrs = f' {" ".join(ppr_parts)}' if ppr_parts else ""
    bullet_xml = '<a:buChar char="•"/>' if bullet else ""
    margin_xml = ' marL="285750" indent="-171450"' if bullet else ""
    ppr = f"<a:pPr{ppr_attrs}{margin_xml}>{bullet_xml}</a:pPr>" if (ppr_attrs or bullet) else ""
    bold_attr = ' b="1"' if bold else ""
    return (
        f"<a:p>{ppr}<a:r><a:rPr lang=\"ru-RU\" sz=\"{size}\"{bold_attr}>"
        f"{solid_fill(color)}<a:latin typeface=\"Inter\"/><a:cs typeface=\"Inter\"/>"
        f"</a:rPr><a:t>{x(text)}</a:t></a:r></a:p>"
    )


def text_box(
    shape_id: int,
    name: str,
    left: float,
    top: float,
    width: float,
    height: float,
    paragraphs_xml: str,
    *,
    fill: str | None = None,
    border: str | None = None,
    radius: bool = False,
    margin: int = 91_440,
) -> str:
    prst = "roundRect" if radius else "rect"
    fill_xml = solid_fill(fill) if fill else no_fill()
    line_xml = line(border, 9_000) if border else '<a:ln><a:noFill/></a:ln>'
    return f"""
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="{shape_id}" name="{x(name)}"/>
          <p:cNvSpPr txBox="1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="{emu(left)}" y="{emu(top)}"/><a:ext cx="{emu(width)}" cy="{emu(height)}"/></a:xfrm>
          <a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>
          {fill_xml}
          {line_xml}
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="{margin}" rIns="{margin}" tIns="{margin}" bIns="{margin}"/>
          <a:lstStyle/>
          {paragraphs_xml}
        </p:txBody>
      </p:sp>
    """


def rect(shape_id: int, left: float, top: float, width: float, height: float, fill: str) -> str:
    return f"""
      <p:sp>
        <p:nvSpPr><p:cNvPr id="{shape_id}" name="shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="{emu(left)}" y="{emu(top)}"/><a:ext cx="{emu(width)}" cy="{emu(height)}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          {solid_fill(fill)}
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
      </p:sp>
    """


def fit_bullets(bullets: tuple[str, ...], limit: int = 5) -> tuple[str, ...]:
    return bullets[:limit]


def footer(style: Style, slide_no: int, slide_count: int) -> str:
    text = f"WikiAI | {style.label} | {slide_no:02d}/{slide_count:02d}"
    return text_box(
        900,
        "footer",
        0.55,
        7.05,
        12.2,
        0.35,
        paragraph(text, size=900, color=style.footer),
        margin=0,
    )


def executive_visual(style: Style, slide: Slide, shape_id: int) -> str:
    p = [
        paragraph("Визуальный акцент", size=1500, color=style.accent, bold=True),
        paragraph(slide.visual, size=1150, color=style.fg),
        paragraph("Управляемость", size=1100, color=style.accent2, bold=True),
        paragraph("Права, источники, стоимость и эксплуатация под контролем.", size=1000, color=style.muted),
    ]
    return text_box(shape_id, "visual", 7.55, 1.45, 4.55, 3.85, "".join(p), fill=style.soft, border=style.line, radius=True)


def architecture_visual(style: Style, slide: Slide, shape_id: int) -> str:
    labels = ("Источник", "Контроль", "AI-слой", "Результат")
    xml = [
        text_box(shape_id, "visual-title", 5.2, 1.08, 7.05, 0.55, paragraph(slide.visual, size=1100, color=style.muted), margin=45_720),
    ]
    x0 = 5.35
    for index, label in enumerate(labels):
        left = x0 + index * 1.75
        xml.append(
            text_box(
                shape_id + 1 + index,
                f"flow-{index}",
                left,
                2.2,
                1.42,
                1.05,
                paragraph(label, size=1150, color=style.fg, bold=True, align="ctr"),
                fill="FFFFFF",
                border=style.accent if index == 2 else style.line,
                radius=True,
                margin=45_720,
            )
        )
        if index < len(labels) - 1:
            xml.append(
                text_box(
                    shape_id + 10 + index,
                    f"arrow-{index}",
                    left + 1.37,
                    2.45,
                    0.42,
                    0.36,
                    paragraph("->", size=1500, color=style.accent, bold=True, align="ctr"),
                    margin=0,
                )
            )
    xml.append(
        text_box(
            shape_id + 20,
            "note",
            5.55,
            3.75,
            6.55,
            1.15,
            paragraph("Граница ответственности фиксируется до обращения к LLM.", size=1150, color=style.fg, bold=True)
            + paragraph("Контент, права и журнал аудита остаются управляемыми.", size=1000, color=style.muted),
            fill="FFFFFF",
            border=style.line,
            radius=True,
        )
    )
    return "".join(xml)


def product_visual(style: Style, slide: Slide, shape_id: int) -> str:
    cards = ("Быстрее найти", "Понять источник", "Принять решение")
    xml = [
        text_box(shape_id, "visual-title", 0.65, 1.35, 11.55, 0.55, paragraph(slide.visual, size=1200, color=style.muted, align="ctr"), margin=0)
    ]
    for index, card in enumerate(cards):
        xml.append(
            text_box(
                shape_id + index + 1,
                f"card-{index}",
                0.85 + index * 4.0,
                4.55,
                3.55,
                1.15,
                paragraph(card, size=1400, color=style.fg, bold=True, align="ctr")
                + paragraph("Сценарий пользователя", size=950, color=style.muted, align="ctr"),
                fill="FFFFFF",
                border=style.line,
                radius=True,
            )
        )
    return "".join(xml)


def title_area(style: Style, slide: Slide, slide_no: int) -> str:
    if style.key == "executive":
        return (
            rect(2, 0, 0, 13.33, 0.16, style.accent)
            + text_box(3, "style", 0.62, 0.25, 2.2, 0.36, paragraph(style.label, size=1050, color=style.accent, bold=True), margin=0)
            + text_box(4, "title", 0.62, 0.62, 7.35, 0.8, paragraph(slide.title, size=2600, color=style.fg, bold=True), margin=0)
        )
    if style.key == "architecture":
        return (
            rect(2, 0, 0, 0.2, 7.5, style.accent)
            + text_box(3, "style", 0.48, 0.25, 2.7, 0.32, paragraph(style.label, size=950, color=style.accent, bold=True), margin=0)
            + text_box(4, "title", 0.48, 0.55, 11.7, 0.7, paragraph(slide.title, size=2300, color=style.fg, bold=True), margin=0)
        )
    return (
        rect(2, 0, 0, 13.33, 0.22, style.accent)
        + text_box(3, "style", 9.6, 0.35, 2.6, 0.38, paragraph(style.label, size=950, color=style.accent, bold=True, align="r"), margin=0)
        + text_box(4, "title", 0.62, 0.52, 9.8, 0.88, paragraph(slide.title, size=2500, color=style.fg, bold=True), margin=0)
    )


def slide_body(style: Style, slide: Slide, slide_no: int) -> str:
    bullet_xml = "".join(
        paragraph(item, size=1250 if style.key != "architecture" else 1150, color=style.fg, bullet=True)
        for item in fit_bullets(slide.bullets)
    )
    thesis_size = 1350 if style.key != "architecture" else 1200

    if style.key == "executive":
        return (
            text_box(10, "thesis", 0.65, 1.42, 6.65, 0.86, paragraph(slide.thesis, size=thesis_size, color=style.muted), fill="F9FAFB", border=style.line, radius=True)
            + text_box(11, "bullets", 0.72, 2.5, 6.55, 3.9, bullet_xml, margin=91_440)
            + executive_visual(style, slide, 30)
        )
    if style.key == "architecture":
        return (
            text_box(10, "thesis", 0.52, 1.25, 4.45, 0.95, paragraph(slide.thesis, size=thesis_size, color=style.muted), fill="FFFFFF", border=style.line, radius=True)
            + text_box(11, "bullets", 0.58, 2.35, 4.45, 4.25, bullet_xml, fill="FFFFFF", border=style.line, radius=True)
            + architecture_visual(style, slide, 30)
        )
    return (
        text_box(10, "thesis", 0.78, 1.55, 11.2, 0.78, paragraph(slide.thesis, size=thesis_size, color=style.fg, bold=True, align="ctr"), fill=style.soft, border=style.line, radius=True)
        + text_box(11, "bullets", 1.05, 2.55, 10.2, 1.8, bullet_xml, fill="FFFFFF", border=style.line, radius=True)
        + product_visual(style, slide, 40)
    )


def slide_xml(style: Style, slide: Slide, slide_no: int, slide_count: int) -> str:
    shapes = (
        rect(1_000, 0, 0, 13.33, 7.5, style.bg)
        + title_area(style, slide, slide_no)
        + slide_body(style, slide, slide_no)
        + footer(style, slide_no, slide_count)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{SLIDE_W}" cy="{SLIDE_H}"/><a:chOff x="0" y="0"/><a:chExt cx="{SLIDE_W}" cy="{SLIDE_H}"/></a:xfrm></p:grpSpPr>
      {shapes}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>
"""


def slide_rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>
"""


def presentation_xml(slide_count: int) -> str:
    slide_ids = "\n".join(
        f'    <p:sldId id="{256 + idx}" r:id="rId{idx + 2}"/>'
        for idx in range(slide_count)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>
{slide_ids}
  </p:sldIdLst>
  <p:sldSz cx="{SLIDE_W}" cy="{SLIDE_H}" type="wide"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle/>
</p:presentation>
"""


def presentation_rels_xml(slide_count: int) -> str:
    rels = [
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    ]
    rels.extend(
        f'<Relationship Id="rId{idx + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{idx + 1}.xml"/>'
        for idx in range(slide_count)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  {' '.join(rels)}
</Relationships>
"""


def content_types_xml(slide_count: int) -> str:
    slide_overrides = "\n".join(
        f'  <Override PartName="/ppt/slides/slide{idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for idx in range(1, slide_count + 1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
{slide_overrides}
</Types>
"""


def root_rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
"""


def app_xml(slide_count: int) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
            xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>WikiAI PPTX generator</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>{slide_count}</Slides>
  <Notes>0</Notes>
  <HiddenSlides>0</HiddenSlides>
  <Company>WikiAI</Company>
</Properties>
"""


def core_xml(style: Style) -> str:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:dcmitype="http://purl.org/dc/dcmitype/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>WikiAI - {x(style.label)}</dc:title>
  <dc:creator>WikiAI</dc:creator>
  <cp:lastModifiedBy>WikiAI</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>
"""


def slide_master_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>
"""


def slide_master_rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>
"""


def slide_layout_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>
"""


def slide_layout_rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>
"""


def theme_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="WikiAI">
  <a:themeElements>
    <a:clrScheme name="WikiAI">
      <a:dk1><a:srgbClr val="111827"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="374151"/></a:dk2>
      <a:lt2><a:srgbClr val="F9FAFB"/></a:lt2>
      <a:accent1><a:srgbClr val="7C3AED"/></a:accent1>
      <a:accent2><a:srgbClr val="059669"/></a:accent2>
      <a:accent3><a:srgbClr val="D97706"/></a:accent3>
      <a:accent4><a:srgbClr val="DC2626"/></a:accent4>
      <a:accent5><a:srgbClr val="0F766E"/></a:accent5>
      <a:accent6><a:srgbClr val="4B5563"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="WikiAI">
      <a:majorFont><a:latin typeface="Inter"/><a:ea typeface=""/><a:cs typeface="Inter"/></a:majorFont>
      <a:minorFont><a:latin typeface="Inter"/><a:ea typeface=""/><a:cs typeface="Inter"/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="WikiAI">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>
"""


def build_pptx(style: Style, slides: list[Slide], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml(len(slides)))
        zf.writestr("_rels/.rels", root_rels_xml())
        zf.writestr("docProps/app.xml", app_xml(len(slides)))
        zf.writestr("docProps/core.xml", core_xml(style))
        zf.writestr("ppt/presentation.xml", presentation_xml(len(slides)))
        zf.writestr("ppt/_rels/presentation.xml.rels", presentation_rels_xml(len(slides)))
        zf.writestr("ppt/slideMasters/slideMaster1.xml", slide_master_xml())
        zf.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", slide_master_rels_xml())
        zf.writestr("ppt/slideLayouts/slideLayout1.xml", slide_layout_xml())
        zf.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", slide_layout_rels_xml())
        zf.writestr("ppt/theme/theme1.xml", theme_xml())
        for idx, slide in enumerate(slides, start=1):
            zf.writestr(f"ppt/slides/slide{idx}.xml", slide_xml(style, slide, idx, len(slides)))
            zf.writestr(f"ppt/slides/_rels/slide{idx}.xml.rels", slide_rels_xml())


def find_non_russian_phrases(text: str) -> list[str]:
    allow = "|".join(re.escape(item) for item in sorted(TECH_WHITELIST, key=len, reverse=True))
    cleaned = re.sub(rf"\b(?:{allow})\b", "", text)
    words = re.findall(r"\b[A-Za-z][A-Za-z-]{2,}\b", cleaned)
    return sorted(set(words))


def selected_styles(value: str) -> tuple[Style, ...]:
    if value == "all":
        return STYLES
    for style in STYLES:
        if style.key == value:
            return (style,)
    choices = ", ".join(("all", *(style.key for style in STYLES)))
    raise ValueError(f"Unknown style '{value}'. Expected one of: {choices}")


def output_filename(style: Style, filename_prefix: str | None) -> str:
    if not filename_prefix:
        return style.filename
    return f"{filename_prefix}-{style.key}.pptx"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate WikiAI PPTX decks.")
    parser.add_argument("--slides", default="docs/wikiai-pptx-slides.md", type=Path)
    parser.add_argument("--out-dir", default="dist/presentations", type=Path)
    parser.add_argument("--style", default="all", choices=("all", *(style.key for style in STYLES)))
    parser.add_argument("--filename-prefix")
    parser.add_argument("--strict-language", action="store_true")
    args = parser.parse_args()

    source_text = args.slides.read_text(encoding="utf-8")
    if args.strict_language:
        unexpected = find_non_russian_phrases(source_text)
        if unexpected:
            raise SystemExit(f"Unexpected English words outside whitelist: {', '.join(unexpected)}")

    slides = parse_slides(args.slides)
    for style in selected_styles(args.style):
        out_path = args.out_dir / output_filename(style, args.filename_prefix)
        build_pptx(style, slides, out_path)
        print(f"Generated {out_path} ({len(slides)} slides, {style.label})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
