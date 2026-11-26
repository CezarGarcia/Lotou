interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Cache em memória do processo (L1), com TTL e tamanho máximo. Fica na frente
 * do Redis para a chave quente da abertura de vendas: milhares de leituras do
 * mesmo show por segundo viram uma leitura do Redis a cada TTL por instância.
 *
 * Despeja o item usado há mais tempo (LRU): o `Map` guarda a ordem de
 * inserção, e cada leitura reinsere o item no fim.
 */
export class LocalCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) {
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
