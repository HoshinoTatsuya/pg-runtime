/** Снимок пула pg: сколько соединений всего, свободно, выдано и сколько вызывающих ждут. */
export interface PoolStats {
  readonly total: number;
  readonly idle: number;
  readonly inUse: number;
  readonly waiting: number;
}
