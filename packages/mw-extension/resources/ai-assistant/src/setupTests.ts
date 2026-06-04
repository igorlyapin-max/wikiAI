import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const testStorage = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return testStorage.size;
  },
  clear() {
    testStorage.clear();
  },
  getItem(key: string) {
    return testStorage.get(key) ?? null;
  },
  key(index: number) {
    return Array.from(testStorage.keys())[index] ?? null;
  },
  removeItem(key: string) {
    testStorage.delete(key);
  },
  setItem(key: string, value: string) {
    testStorage.set(key, value);
  },
};

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
});

afterEach(() => {
  cleanup();
});

class TestIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(window, 'IntersectionObserver', {
  configurable: true,
  writable: true,
  value: TestIntersectionObserver,
});

Element.prototype.scrollIntoView = function scrollIntoView(): void {};
