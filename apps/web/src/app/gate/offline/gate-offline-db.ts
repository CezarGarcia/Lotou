import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';
import { CheckinShow, OfflineScan } from '../data/checkin.api';
import { LocalEntry } from './offline-check';
import { OfflinePackage } from './offline-package';

/** O pacote de um show como fica no aparelho. */
export interface StoredPackage {
  showId: string;
  /** Quando o aparelho baixou a lista (UTC). */
  savedAt: string;
  pkg: OfflinePackage;
  /** Nome do show e local, para o topo do leitor abrir sem internet. */
  show: CheckinShow | null;
}

/** Uma leitura aceita sem internet, esperando a rede voltar. */
export interface PendingScan extends OfflineScan {
  showId: string;
  gate: string;
  deviceId: string;
  ticketId: string;
}

/**
 * O armazenamento da portaria no aparelho: os pacotes por show, as entradas
 * que o aparelho conhece e a fila de leituras para enviar. Nada de dado
 * pessoal: o pacote só tem ingressos, setores e lugares.
 */
export interface GateOfflineDb {
  loadPackage(showId: string): Promise<StoredPackage | null>;
  hasPackage(showId: string): Promise<boolean>;
  savePackage(stored: StoredPackage): Promise<void>;
  /** Os shows com pacote guardado, para a escolha do show sem internet. */
  storedShows(): Promise<CheckinShow[]>;
  entries(showId: string): Promise<LocalEntry[]>;
  saveEntry(entry: LocalEntry): Promise<void>;
  /** A fila inteira, de todos os shows, na ordem da leitura. */
  pending(): Promise<PendingScan[]>;
  enqueue(scan: PendingScan): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
}

const byScan = (a: PendingScan, b: PendingScan) =>
  a.scannedAt.localeCompare(b.scannedAt) || a.id.localeCompare(b.id);

/** Em memória: nos testes e onde o navegador não tem IndexedDB. */
export class MemoryGateOfflineDb implements GateOfflineDb {
  private readonly packages = new Map<string, StoredPackage>();
  private readonly known = new Map<string, LocalEntry>();
  private readonly queue = new Map<string, PendingScan>();

  async loadPackage(showId: string) {
    return this.packages.get(showId) ?? null;
  }

  async hasPackage(showId: string) {
    return this.packages.has(showId);
  }

  async savePackage(stored: StoredPackage) {
    this.packages.set(stored.showId, stored);
  }

  async storedShows() {
    return [...this.packages.values()].flatMap((stored) => (stored.show ? [stored.show] : []));
  }

  async entries(showId: string) {
    return [...this.known.values()].filter((entry) => entry.showId === showId);
  }

  async saveEntry(entry: LocalEntry) {
    this.known.set(`${entry.showId}/${entry.ticketId}`, entry);
  }

  async pending() {
    return [...this.queue.values()].sort(byScan);
  }

  async enqueue(scan: PendingScan) {
    this.queue.set(scan.id, scan);
  }

  async remove(ids: readonly string[]) {
    ids.forEach((id) => this.queue.delete(id));
  }
}

const DB_NAME = 'lotou-portaria';
const DB_VERSION = 1;
const PACKAGES = 'packages';
const ENTRIES = 'entries';
const QUEUE = 'queue';

/**
 * IndexedDB sem biblioteca: uma base `lotou-portaria` com três stores. Os
 * pacotes podem ter dezenas de milhares de ingressos, e o `localStorage`
 * (síncrono, uns 5 MB) não serve para isso. Se a base não abre (aba anônima
 * de alguns navegadores), o leitor segue em memória: valida sem internet
 * enquanto a aba estiver aberta.
 */
export class IndexedDbGateOfflineDb implements GateOfflineDb {
  private db?: Promise<IDBDatabase | null>;
  private readonly memory = new MemoryGateOfflineDb();

  constructor(private readonly factory: IDBFactory) {}

  async loadPackage(showId: string) {
    const db = await this.open();
    return db
      ? ((await request<StoredPackage | undefined>(db, [PACKAGES], 'readonly', (tx) =>
          tx.objectStore(PACKAGES).get(showId),
        )) ?? null)
      : this.memory.loadPackage(showId);
  }

  async hasPackage(showId: string) {
    const db = await this.open();
    return db
      ? (await request<number>(db, [PACKAGES], 'readonly', (tx) =>
          tx.objectStore(PACKAGES).count(showId),
        )) > 0
      : this.memory.hasPackage(showId);
  }

  async savePackage(stored: StoredPackage) {
    const db = await this.open();
    return db
      ? void (await request(db, [PACKAGES], 'readwrite', (tx) =>
          tx.objectStore(PACKAGES).put(stored),
        ))
      : this.memory.savePackage(stored);
  }

  async storedShows() {
    const db = await this.open();
    if (!db) {
      return this.memory.storedShows();
    }
    // Só os shows, sem trazer os ingressos de todos os pacotes para a memória.
    const shows: CheckinShow[] = [];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([PACKAGES], 'readonly');
      const cursor = tx.objectStore(PACKAGES).openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current) {
          const show = (current.value as StoredPackage).show;
          if (show) shows.push(show);
          current.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return shows;
  }

  async entries(showId: string) {
    const db = await this.open();
    return db
      ? request<LocalEntry[]>(db, [ENTRIES], 'readonly', (tx) =>
          tx.objectStore(ENTRIES).index('showId').getAll(showId),
        )
      : this.memory.entries(showId);
  }

  async saveEntry(entry: LocalEntry) {
    const db = await this.open();
    return db
      ? void (await request(db, [ENTRIES], 'readwrite', (tx) => tx.objectStore(ENTRIES).put(entry)))
      : this.memory.saveEntry(entry);
  }

  async pending() {
    const db = await this.open();
    if (!db) {
      return this.memory.pending();
    }
    const scans = await request<PendingScan[]>(db, [QUEUE], 'readonly', (tx) =>
      tx.objectStore(QUEUE).getAll(),
    );
    return scans.sort(byScan);
  }

  async enqueue(scan: PendingScan) {
    const db = await this.open();
    return db
      ? void (await request(db, [QUEUE], 'readwrite', (tx) => tx.objectStore(QUEUE).put(scan)))
      : this.memory.enqueue(scan);
  }

  async remove(ids: readonly string[]) {
    const db = await this.open();
    if (!db) {
      return this.memory.remove(ids);
    }
    await request(db, [QUEUE], 'readwrite', (tx) => {
      const store = tx.objectStore(QUEUE);
      ids.forEach((id) => store.delete(id));
      return undefined;
    });
  }

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        const opening = this.factory.open(DB_NAME, DB_VERSION);
        opening.onupgradeneeded = () => {
          const db = opening.result;
          db.createObjectStore(PACKAGES, { keyPath: 'showId' });
          db.createObjectStore(ENTRIES, { keyPath: ['showId', 'ticketId'] }).createIndex(
            'showId',
            'showId',
          );
          db.createObjectStore(QUEUE, { keyPath: 'id' });
        };
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => resolve(null);
        opening.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.db;
  }
}

/** Uma operação numa transação; resolve quando a transação termina (gravou de fato). */
function request<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => IDBRequest | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const pending = work(tx);
    tx.oncomplete = () => resolve(pending?.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** O armazenamento do aparelho: IndexedDB no navegador, memória onde ele não existe. */
export const GATE_OFFLINE_DB = new InjectionToken<GateOfflineDb>('GATE_OFFLINE_DB', {
  providedIn: 'root',
  factory: () => {
    const factory = inject(DOCUMENT).defaultView?.indexedDB;
    return factory ? new IndexedDbGateOfflineDb(factory) : new MemoryGateOfflineDb();
  },
});
