"""Corpos de resposta da API, em camelCase como o resto do Lotou. Dinheiro em centavos (inteiro)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True)


# ------------------------------------------------------------------- vendas


class HourlySales(ApiModel):
    hour: datetime
    tickets_sold: int
    revenue_cents: int
    orders: int


class LotTransition(ApiModel):
    type: Literal["OPENED", "SOLD_OUT"]
    at: datetime
    price_cents: int | None = None
    available: int | None = None


class LotSales(ApiModel):
    lot_id: str
    name: str | None
    price_cents: int | None
    quantity: int | None
    tickets_sold: int
    revenue_cents: int
    # Último fato do inventory sobre o lote; `null` se ele ainda não abriu nem esgotou.
    status: Literal["ON_SALE", "SOLD_OUT"] | None
    opened_at: datetime | None
    sold_out_at: datetime | None
    timeline: list[LotTransition]


class SectorSales(ApiModel):
    sector_id: str
    name: str | None
    kind: str | None
    capacity: int | None
    tickets_sold: int
    occupancy: float | None
    revenue_cents: int
    orders: int
    lots: list[LotSales]
    hourly: list[HourlySales]


class SalesTotals(ApiModel):
    tickets_sold: int
    capacity: int
    occupancy: float | None
    revenue_cents: int
    orders: int


class ShowSales(ApiModel):
    show_id: str
    title: str
    status: str
    timezone: str
    totals: SalesTotals
    sectors: list[SectorSales]
    hourly: list[HourlySales]


# --------------------------------------------------------------- relatório


class Statement(ApiModel):
    show_id: str
    title: str
    status: str
    partial: bool
    currency: str
    gross_sales_cents: int
    discounts_cents: int
    refunds_cents: int
    platform_fee_cents: int
    receivable_cents: int
    orders_created: int
    confirmed_orders: int
    cancelled_orders: int
    cancelled_by_reason: dict[str, int]
    tickets_sold: int
    tickets_issued: int
    last_event_at: datetime | None


# ----------------------------------------------------------------- pedidos


class OrderItem(ApiModel):
    sector_id: str
    sector_name: str
    lot_id: str
    lot_name: str
    seat: str | None
    unit_price_cents: int


class Ticket(ApiModel):
    ticket_id: str
    sector_id: str
    sector_name: str
    seat: str | None


class TimelineEntry(ApiModel):
    status: str
    at: datetime
    reason: str | None = None


class ShowSummary(ApiModel):
    title: str
    artist: str
    starts_at: datetime
    venue_name: str
    city: str
    timezone: str


class Order(ApiModel):
    order_id: str
    show_id: str
    status: str | None
    total_cents: int | None
    items: list[OrderItem]
    tickets: list[Ticket]
    created_at: datetime | None
    confirmed_at: datetime | None
    cancelled_at: datetime | None
    cancel_reason: str | None
    tickets_issued_at: datetime | None
    timeline: list[TimelineEntry]
    show: ShowSummary | None


class OrderPage(ApiModel):
    items: list[Order]
    # Devolva em `cursor` para ler a próxima página; `null` na última.
    next_cursor: str | None


# ------------------------------------------------------- shows do produtor


class ProducerShow(ApiModel):
    show_id: str
    title: str
    artist: str
    starts_at: datetime
    timezone: str
    venue_name: str
    city: str
    status: str
    tickets_sold: int
    revenue_cents: int


class ProducerShowPage(ApiModel):
    items: list[ProducerShow]
    # Devolva em `cursor` para ler a próxima página; `null` na última.
    next_cursor: str | None


# ------------------------------------------------------------------ replay


class PartitionOffset(ApiModel):
    topic: str
    partition: int
    offset: int


class Replay(ApiModel):
    generation: int
    status: str
    started_at: datetime
    switched_at: datetime | None
    finished_at: datetime | None
    events_applied: int | None
    end_offsets: list[PartitionOffset]
    error: str | None
