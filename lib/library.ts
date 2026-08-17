import type { ConversionResult } from "./pdf-to-markdown";

const DB_NAME = "moye-library";
const STORE_NAME = "documents";
const DB_VERSION = 1;

export type LibraryRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  filename: string;
  fileSize: number;
  lastModified: number;
  pdf: Blob;
  result: ConversionResult;
};

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地资料库读取失败。"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地资料库写入失败。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地资料库写入已中止。"));
  });
}

function openLibrary() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("这个浏览器不支持本地资料库。"));
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地资料库。"));
  });
}

export async function saveToLibrary(file: File, result: ConversionResult) {
  const database = await openLibrary();
  const now = Date.now();
  const id = `${file.name}:${file.size}:${file.lastModified}:${now}:${crypto.randomUUID()}`;
  const record: LibraryRecord = {
    id,
    createdAt: now,
    updatedAt: now,
    filename: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    pdf: file.slice(0, file.size, "application/pdf"),
    result,
  };
  const writeTransaction = database.transaction(STORE_NAME, "readwrite");
  writeTransaction.objectStore(STORE_NAME).put(record);
  await transactionDone(writeTransaction);
  database.close();
  return record;
}

export async function listLibrary() {
  const database = await openLibrary();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const records = await requestResult<LibraryRecord[]>(transaction.objectStore(STORE_NAME).getAll());
  database.close();
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteFromLibrary(id: string) {
  const database = await openLibrary();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(id);
  await transactionDone(transaction);
  database.close();
}
