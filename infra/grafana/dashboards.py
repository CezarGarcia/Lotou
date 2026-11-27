"""Gera os dashboards do Lotou (docs/projeto.md, "Dashboards") em infra/grafana/dashboards/.

O Grafana do Compose lê os JSON gerados (provisionamento, sem edição pela interface). Para
mudar um painel, mude este script e rode `python3 infra/grafana/dashboards.py`.
"""

import json
from pathlib import Path

OUT = Path(__file__).parent / "dashboards"
PROM = {"type": "prometheus", "uid": "prometheus"}


def pg(uid: str) -> dict:
    return {"type": "grafana-postgresql-datasource", "uid": uid}


class Board:
    def __init__(self, uid: str, title: str, description: str, refresh: str = "10s", time_from: str = "now-1h"):
        self.uid, self.title, self.description = uid, title, description
        self.refresh, self.time_from = refresh, time_from
        self.panels: list[dict] = []
        self.variables: list[dict] = []
        self.y = 0
        self.x = 0
        self.row_height = 0

    def row(self, title: str) -> None:
        self.newline()
        self.panels.append({"type": "row", "title": title, "collapsed": False, "panels": [],
                            "gridPos": {"h": 1, "w": 24, "x": 0, "y": self.y}, "id": len(self.panels) + 1})
        self.y += 1

    def newline(self) -> None:
        if self.x:
            self.y += self.row_height
            self.x, self.row_height = 0, 0

    def add(self, panel: dict, w: int, h: int) -> None:
        if self.x + w > 24:
            self.newline()
        panel["gridPos"] = {"h": h, "w": w, "x": self.x, "y": self.y}
        panel["id"] = len(self.panels) + 1
        self.panels.append(panel)
        self.x += w
        self.row_height = max(self.row_height, h)

    def json(self) -> dict:
        return {
            "uid": self.uid, "title": self.title, "description": self.description, "tags": ["lotou"],
            "timezone": "browser", "editable": False, "schemaVersion": 41, "version": 1,
            "refresh": self.refresh, "time": {"from": self.time_from, "to": "now"},
            "templating": {"list": self.variables}, "panels": self.panels,
            "links": [{"title": "Dashboards do Lotou", "type": "dashboards", "tags": ["lotou"], "asDropdown": True}],
        }


def target(expr: str, legend: str = "", ref: str = "A", instant: bool = False) -> dict:
    return {"refId": ref, "datasource": PROM, "expr": expr, "legendFormat": legend or "__auto",
            "range": not instant, "instant": instant}


def timeseries(title: str, targets: list[dict], unit: str = "short", description: str = "",
               stack: bool = False, thresholds: list | None = None) -> dict:
    defaults = {"unit": unit, "custom": {"fillOpacity": 15 if stack else 8, "lineWidth": 2,
                                         "stacking": {"mode": "normal" if stack else "none"},
                                         "showPoints": "never", "spanNulls": True}}
    if thresholds:
        defaults["thresholds"] = {"mode": "absolute", "steps": thresholds}
        defaults["custom"]["thresholdsStyle"] = {"mode": "line+area"}
    return {"type": "timeseries", "title": title, "description": description, "datasource": PROM,
            "targets": targets, "fieldConfig": {"defaults": defaults, "overrides": []},
            "options": {"legend": {"displayMode": "list", "placement": "bottom"},
                        "tooltip": {"mode": "multi", "sort": "desc"}}}


def stat(title: str, expr_or_sql: str, unit: str = "short", description: str = "", datasource: dict = PROM,
         steps: list | None = None, decimals: int | None = None) -> dict:
    tgt = (target(expr_or_sql, instant=True) if datasource is PROM else
           {"refId": "A", "datasource": datasource, "rawSql": expr_or_sql, "rawQuery": True,
            "editorMode": "code", "format": "table"})
    defaults = {"unit": unit, "thresholds": {"mode": "absolute", "steps": steps or [{"color": "green", "value": None}]},
                "color": {"mode": "thresholds"}}
    if decimals is not None:
        defaults["decimals"] = decimals
    return {"type": "stat", "title": title, "description": description, "datasource": datasource, "targets": [tgt],
            "fieldConfig": {"defaults": defaults, "overrides": []},
            "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "background",
                        "graphMode": "none", "textMode": "value"}}


def table(title: str, sql: str, uid: str, description: str = "") -> dict:
    return {"type": "table", "title": title, "description": description, "datasource": pg(uid),
            "targets": [{"refId": "A", "datasource": pg(uid), "rawSql": sql, "rawQuery": True,
                         "editorMode": "code", "format": "table"}],
            "fieldConfig": {"defaults": {}, "overrides": []}, "options": {"showHeader": True, "cellHeight": "sm"}}


BAD = [{"color": "green", "value": None}, {"color": "red", "value": 1}]
HIST = "histogram_quantile({q}, sum by (le{by}) (rate({metric}_bucket{{{sel}}}[$__rate_interval])))"


def quantile(q: float, metric: str, sel: str, by: str = "") -> str:
    return HIST.format(q=q, metric=metric, sel=sel, by=f", {by}" if by else "")


# ------------------------------------------------------------------ 1. abertura de vendas

def opening() -> Board:
    b = Board("lotou-abertura", "Abertura de vendas ao vivo",
              "Fila virtual, reservas por segundo, conflitos de assento, ingressos restantes e as invariantes de venda.",
              refresh="5s", time_from="now-30m")
    reserve = 'service_name="inventory-service",http_route="/v1/reservations",http_request_method="POST"'
    b.row("Agora")
    b.add(stat("Reservas por segundo", 'sum(rate(ticket_reservations_total{result="reserved"}[2m]))', "reqps", decimals=1), 6, 4)
    b.add(stat("p99 da reserva", quantile(0.99, "http_server_request_duration_seconds", reserve), "s",
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 0.3}, {"color": "red", "value": 0.5}]), 6, 4)
    b.add(stat("Pessoas na fila", "sum(queue_length)", "short"), 6, 4)
    b.add(stat("Invariantes de venda violadas", INVARIANTS_SQL, "short", datasource=pg("pg-inventory"), steps=BAD,
               description="Lote ou setor com mais reservas ativas que ingressos, ou cadeira em duas reservas. Tem que ser zero."), 6, 4)
    b.row("Reservas")
    b.add(timeseries("Reservas por resultado", [target("sum by (result) (rate(ticket_reservations_total[$__rate_interval]))", "{{result}}")],
                     "reqps", "reservado, esgotado, assento ocupado ou limite do CPF", stack=True), 12, 8)
    b.add(timeseries("Duração da reserva", [
        target(quantile(0.5, "http_server_request_duration_seconds", reserve), "p50"),
        target(quantile(0.99, "http_server_request_duration_seconds", reserve), "p99", "B")], "s"), 12, 8)
    b.add(timeseries("Conflitos de assento", [target("sum(rate(seat_hold_conflicts_total[$__rate_interval]))", "conflitos/s")], "reqps",
                     "Duas pessoas tentando a mesma cadeira; a segunda recebe assento ocupado."), 12, 7)
    b.add(timeseries("Pedidos criados no gateway", [
        target('sum by (http_response_status_code) (rate(http_server_request_duration_seconds_count{service_name="api-gateway",http_route=~"reserve|place-order"}[$__rate_interval]))',
               "{{http_response_status_code}}")], "reqps", "Reservas e pedidos por status HTTP; 429 é o rate limit.", stack=True), 12, 7)
    b.row("Fila virtual")
    b.add(timeseries("Tamanho da fila por show", [target("sum by (show_id) (queue_length)", "{{show_id}}")]), 12, 7)
    b.add(timeseries("Admissões por segundo", [target("sum(rate(queue_admitted_total[$__rate_interval]))", "admitidos/s")], "reqps"), 12, 7)
    b.row("Estoque")
    b.add(table("Ingressos restantes por lote (shows com vendas abertas)", """
SELECT left(l.show_id::text, 8) AS show, s.name AS setor, l.name AS lote, l.status,
       l.available AS restantes, l.quantity AS total,
       round(100.0 * (l.quantity - l.available) / nullif(l.quantity, 0), 1) AS "vendido (%)"
FROM lots l
JOIN sectors s ON s.show_id = l.show_id AND s.id = l.sector_id
JOIN shows sh ON sh.id = l.show_id
WHERE sh.status = 'ON_SALE' AND l.status <> 'SCHEDULED'
ORDER BY sh.starts_at, s.position, l.position""", "pg-inventory",
                "Lido do Postgres do inventory. No motor Redis, o Postgres recebe as reservas pelo stream, com alguns milissegundos de atraso."), 24, 10)
    return b


INVARIANTS_SQL = """SELECT
  (SELECT count(*) FROM (SELECT l.id FROM lots l JOIN reservation_items i ON i.lot_id = l.id
     JOIN reservations r ON r.id = i.reservation_id AND r.status IN ('HELD', 'CONFIRMED')
     GROUP BY l.id, l.quantity HAVING count(*) > l.quantity) a)
+ (SELECT count(*) FROM (SELECT s.id FROM sectors s
     JOIN reservations r ON r.show_id = s.show_id AND r.sector_id = s.id AND r.status IN ('HELD', 'CONFIRMED')
     GROUP BY s.id, s.capacity HAVING sum(r.quantity) > s.capacity) b)
+ (SELECT count(*) FROM (SELECT i.seat_id FROM reservation_items i
     JOIN reservations r ON r.id = i.reservation_id AND r.status IN ('HELD', 'CONFIRMED')
     WHERE i.seat_id IS NOT NULL GROUP BY i.seat_id HAVING count(*) > 1) c) AS violacoes"""


# ------------------------------------------------------------------ 2. portaria

def gate() -> Board:
    b = Board("lotou-portaria", "Portaria ao vivo",
              "Entradas por minuto e por portão, leituras recusadas, ocupação do local e a duração do check-in.",
              refresh="5s", time_from="now-30m")
    b.row("Agora")
    b.add(stat("Entradas por minuto", 'sum(rate(checkins_total{result="ACCEPTED"}[2m])) * 60', "short", decimals=0), 6, 4)
    b.add(stat("p99 do check-in", quantile(0.99, "checkin_duration_seconds", ""), "s",
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 0.15}, {"color": "red", "value": 0.2}],
               description="Meta: abaixo de 200 ms (alerta Portaria lenta)."), 6, 4)
    b.add(stat("Recusadas na última hora", 'sum(increase(checkins_total{result!="ACCEPTED"}[1h]))', "short", decimals=0,
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}]), 6, 4)
    b.add(stat("Entradas duplas", "SELECT count(*) FROM (SELECT ticket_id FROM checkins GROUP BY ticket_id HAVING count(*) > 1) d",
               datasource=pg("pg-checkin"), steps=BAD, description="Tem que ser zero: a constraint única barra."), 6, 4)
    b.row("Leituras")
    b.add(timeseries("Entradas por portão (por minuto)",
                     [target('sum by (gate) (rate(checkins_total{result="ACCEPTED"}[$__rate_interval])) * 60', "{{gate}}")],
                     "short", stack=True), 12, 8)
    b.add(timeseries("Leituras por resultado",
                     [target("sum by (result) (rate(checkins_total[$__rate_interval])) * 60", "{{result}}")], "short",
                     "ACCEPTED (verde), ALREADY_USED (amarelo), INVALID_CODE, UNKNOWN_TICKET, CANCELLED, WRONG_SHOW e NOT_OPEN (vermelho), por minuto."), 12, 8)
    b.add(timeseries("Duração do check-in", [
        target(quantile(0.5, "checkin_duration_seconds", ""), "p50"),
        target(quantile(0.99, "checkin_duration_seconds", ""), "p99", "B")], "s",
        thresholds=[{"color": "transparent", "value": None}, {"color": "red", "value": 0.2}]), 24, 7)
    b.row("Ocupação")
    b.add(table("Ocupação por show (shows de hoje e próximos)", """
SELECT s.title AS show, s.venue_name AS local, s.starts_at AS "começa",
       count(DISTINCT c.ticket_id) AS entradas,
       count(DISTINCT v.ticket_id) FILTER (WHERE v.status <> 'CANCELLED') AS ingressos,
       round(100.0 * count(DISTINCT c.ticket_id)
             / nullif(count(DISTINCT v.ticket_id) FILTER (WHERE v.status <> 'CANCELLED'), 0), 1) AS "ocupação (%)"
FROM shows s
LEFT JOIN valid_tickets v ON v.show_id = s.show_id
LEFT JOIN checkins c ON c.show_id = s.show_id
WHERE s.starts_at > now() - interval '1 day' AND s.starts_at < now() + interval '3 days'
GROUP BY s.show_id, s.title, s.venue_name, s.starts_at
ORDER BY s.starts_at""", "pg-checkin", "Da cópia local do checkin-service."), 24, 8)
    return b


# ------------------------------------------------------------------ 3. negócio

def business() -> Board:
    b = Board("lotou-negocio", "Negócio",
              "Pedidos, vendas, cupons, cancelamentos e reembolsos por show.", refresh="30s", time_from="now-6h")
    b.row("Agora")
    b.add(stat("Pedidos confirmados (1 h)", 'sum(increase(orders_total{status="CONFIRMED"}[1h]))', decimals=0), 6, 4)
    b.add(stat("Pedidos cancelados (1 h)", 'sum(increase(orders_total{status="CANCELLED"}[1h]))', decimals=0,
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}]), 6, 4)
    b.add(stat("Pedidos em PENDING há mais de 15 min",
               "SELECT count(*) FROM orders WHERE status = 'PENDING' AND created_at < now() - interval '15 minutes'",
               datasource=pg("pg-orders"), steps=BAD), 6, 4)
    b.add(stat("Pedidos em REFUND_FAILED", "SELECT count(*) FROM orders WHERE status = 'REFUND_FAILED'",
               datasource=pg("pg-orders"), steps=BAD), 6, 4)
    b.row("Fluxo")
    b.add(timeseries("Pedidos por estado final", [target("sum by (status) (rate(orders_total[$__rate_interval])) * 60", "{{status}}")],
                     "short", "por minuto", stack=True), 12, 8)
    b.add(timeseries("Duração da saga", [
        target('histogram_quantile(0.5, sum by (le, saga) (rate(saga_duration_seconds_bucket[$__rate_interval])))', "p50 {{saga}}"),
        target('histogram_quantile(0.95, sum by (le, saga) (rate(saga_duration_seconds_bucket[$__rate_interval])))', "p95 {{saga}}", "B")],
        "s", "Do pedido criado ao fim da saga (confirmado ou compensado)."), 12, 8)
    b.add(timeseries("Reembolsos", [target("sum by (reason, outcome) (rate(refunds_total[$__rate_interval])) * 60", "{{reason}} {{outcome}}")],
                     "short", "por minuto, por motivo (comprador cancelou ou show cancelado) e resultado", stack=True), 12, 7)
    b.add(timeseries("Cupons usados e pagamentos", [
        target("sum(rate(coupon_redemptions_total[$__rate_interval])) * 60", "cupons usados"),
        target("sum by (result) (rate(payments_total[$__rate_interval])) * 60", "pagamento {{result}}", "B")], "short", "por minuto"), 12, 7)
    b.row("Por show")
    b.add(table("Vendas por show", """
SELECT s.title AS show, s.status, s.service_fee_paid_by AS "taxa paga por",
       count(*) FILTER (WHERE o.confirmed_at IS NOT NULL) AS confirmados,
       count(*) FILTER (WHERE o.status = 'REFUNDED') AS reembolsados,
       count(*) FILTER (WHERE o.coupon_id IS NOT NULL AND o.confirmed_at IS NOT NULL) AS "com cupom",
       round(sum(o.subtotal_cents - o.discount_cents) FILTER (WHERE o.status IN ('CONFIRMED', 'REFUNDING', 'REFUND_FAILED')) / 100.0, 2) AS "receita (R$)"
FROM shows s
JOIN orders o ON o.show_id = s.id
GROUP BY s.id, s.title, s.status, s.service_fee_paid_by
ORDER BY confirmados DESC""", "pg-orders",
                "Do Postgres do order-service. Receita = ingressos menos desconto dos pedidos que valem (sem a taxa e sem os reembolsados)."), 24, 9)
    b.add(table("Cupons", """
SELECT s.title AS show, c.code AS cupom, c.kind AS tipo, coalesce(c.percent::text || '%', round(c.amount_cents / 100.0, 2)::text) AS desconto,
       c.uses AS usos, c.max_uses AS limite, c.status, c.valid_until AS "válido até"
FROM coupons c JOIN shows s ON s.id = c.show_id
ORDER BY c.created_at DESC LIMIT 50""", "pg-orders"), 24, 8)
    return b


# ------------------------------------------------------------------ 4. RED por serviço

def red() -> Board:
    b = Board("lotou-red", "RED por serviço e SLO do checkout",
              "Taxa, erros e duração de cada rota, por serviço, e os SLOs de disponibilidade e latência do checkout (ADR 35).")
    b.variables.append({"name": "service", "label": "Serviço", "type": "query", "datasource": PROM,
                        "query": {"query": "label_values(http_server_request_duration_seconds_count, service_name)", "refId": "V"},
                        "refresh": 2, "includeAll": False, "multi": False, "sort": 1,
                        "current": {"text": "api-gateway", "value": "api-gateway"}})
    checkout = 'service_name="api-gateway",http_route=~"reserve|place-order"'
    err = f'sum(increase(http_server_request_duration_seconds_count{{{checkout},http_response_status_code=~"5.."}}[30d]))'
    tot = f'sum(increase(http_server_request_duration_seconds_count{{{checkout}}}[30d]))'
    b.row("SLO do checkout: 99,5% das reservas e pedidos sem erro 5xx, em 30 dias")
    b.add(stat("Disponibilidade (30 dias)", f"1 - ({err} / {tot})", "percentunit", decimals=3,
               steps=[{"color": "red", "value": None}, {"color": "green", "value": 0.995}]), 8, 4)
    b.add(stat("Orçamento de erro restante", f"1 - (({err} / {tot}) / 0.005)", "percentunit", decimals=1,
               steps=[{"color": "red", "value": None}, {"color": "orange", "value": 0.25}, {"color": "green", "value": 0.5}],
               description="100% = nenhum erro no mês; 0% = o orçamento de 0,5% acabou."), 8, 4)
    b.add(stat("Burn rate (1 h)",
               f'(sum(rate(http_server_request_duration_seconds_count{{{checkout},http_response_status_code=~"5.."}}[1h])) / '
               f'sum(rate(http_server_request_duration_seconds_count{{{checkout}}}[1h]))) / 0.005', "short", decimals=1,
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 6}, {"color": "red", "value": 14.4}],
               description="1 = consome o orçamento exatamente em 30 dias. O alerta rápido dispara acima de 14,4 (em 1 h e 5 min)."), 8, 4)
    fast = f'sum(increase(http_server_request_duration_seconds_bucket{{{checkout},le="1"}}[30d]))'
    b.row("SLO de latência do checkout: 99% das reservas e pedidos em menos de 1 s, em 30 dias")
    b.add(stat("Abaixo de 1 s (30 dias)", f"{fast} / {tot}", "percentunit", decimals=3,
               steps=[{"color": "red", "value": None}, {"color": "green", "value": 0.99}]), 8, 4)
    b.add(stat("Orçamento de latência restante", f"1 - ((1 - {fast} / {tot}) / 0.01)", "percentunit", decimals=1,
               steps=[{"color": "red", "value": None}, {"color": "orange", "value": 0.25}, {"color": "green", "value": 0.5}]), 8, 4)
    b.add(stat("Burn rate de latência (1 h)",
               f'(1 - sum(rate(http_server_request_duration_seconds_bucket{{{checkout},le="1"}}[1h])) / '
               f'sum(rate(http_server_request_duration_seconds_count{{{checkout}}}[1h]))) / 0.01', "short", decimals=1,
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 6}, {"color": "red", "value": 14.4}]), 8, 4)
    sel = 'service_name="$service"'
    b.row("$service")
    b.add(timeseries("Requisições por rota", [target(f"sum by (http_route) (rate(http_server_request_duration_seconds_count{{{sel}}}[$__rate_interval]))", "{{http_route}}")],
                     "reqps", stack=True), 8, 8)
    b.add(timeseries("Erros 5xx por rota", [target(
        f'sum by (http_route) (rate(http_server_request_duration_seconds_count{{{sel},http_response_status_code=~"5.."}}[$__rate_interval]))'
        f' / sum by (http_route) (rate(http_server_request_duration_seconds_count{{{sel}}}[$__rate_interval]))', "{{http_route}}")],
        "percentunit"), 8, 8)
    b.add(timeseries("p95 por rota", [target(quantile(0.95, "http_server_request_duration_seconds", sel, "http_route"), "{{http_route}}")], "s"), 8, 8)
    b.add(timeseries("Respostas por status", [target(f"sum by (http_response_status_code) (rate(http_server_request_duration_seconds_count{{{sel}}}[$__rate_interval]))",
                                                     "{{http_response_status_code}}")], "reqps", stack=True), 12, 7)
    b.add(timeseries("p50 e p99 do serviço", [
        target(quantile(0.5, "http_server_request_duration_seconds", sel), "p50"),
        target(quantile(0.99, "http_server_request_duration_seconds", sel), "p99", "B")], "s"), 12, 7)
    return b


# ------------------------------------------------------------------ 5. mensageria

def messaging() -> Board:
    b = Board("lotou-mensageria", "Mensageria",
              "Lag por consumer group no Kafka, DLTs, filas e DLQs do RabbitMQ e o outbox de cada serviço.")
    b.row("Agora")
    b.add(stat("Maior lag em order.events", 'max(kafka_consumer_group_lag_sum_ratio{topic="order.events"})', decimals=0,
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 100}, {"color": "red", "value": 1000}]), 6, 4)
    b.add(stat("Mensagens nas DLQs", 'sum(rabbitmq_message_current{rabbitmq_queue_name=~".+\\\\.dlq",state="ready"})', decimals=0, steps=BAD), 6, 4)
    b.add(stat("Novas nas DLTs (15 min)", 'sum(delta(kafka_partition_current_offset_ratio{topic=~".+\\\\.dlt"}[15m]))', decimals=0,
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}]), 6, 4)
    b.add(stat("Outbox mais antigo sem publicar", "max(outbox_oldest_pending_age_seconds)", "s",
               steps=[{"color": "green", "value": None}, {"color": "orange", "value": 5}, {"color": "red", "value": 60}]), 6, 4)
    b.row("Kafka")
    b.add(timeseries("Lag por consumer group e tópico",
                     [target('sum by (group, topic) (kafka_consumer_group_lag_sum_ratio{topic!~".+\\\\.dlt"})', "{{group}} / {{topic}}")],
                     "short", "Mensagens ainda não lidas. Sobe num pico e volta a zero quando o consumidor alcança."), 12, 9)
    b.add(timeseries("Mensagens publicadas por tópico",
                     [target('sum by (topic) (rate(kafka_partition_current_offset_ratio{topic!~".+\\\\.dlt"}[$__rate_interval]))', "{{topic}}")],
                     "short", "por segundo", stack=True), 12, 9)
    b.add(timeseries("Mensagens nas DLTs", [target('sum by (topic) (kafka_partition_current_offset_ratio{topic=~".+\\\\.dlt"} - kafka_partition_oldest_offset_ratio{topic=~".+\\\\.dlt"})', "{{topic}}")],
                     "short", "Mensagens que um consumidor desistiu de processar."), 12, 7)
    b.add(timeseries("Outbox pendente por serviço", [target("sum by (service_name) (outbox_pending)", "{{service_name}}")], "short",
                     "Mensagens gravadas na transação e ainda não publicadas pelo relay."), 12, 7)
    b.row("RabbitMQ")
    b.add(timeseries("Filas", [target('sum by (rabbitmq_queue_name) (rabbitmq_message_current{state="ready",rabbitmq_queue_name!="",rabbitmq_queue_name!~".+\\\\.dlq"})', "{{rabbitmq_queue_name}}")],
                     "short", "Mensagens prontas, esperando um worker; as filas de retry seguram as mensagens pelo TTL.", stack=True), 12, 8)
    b.add(timeseries("DLQs", [target('sum by (rabbitmq_queue_name) (rabbitmq_message_current{state="ready",rabbitmq_queue_name=~".+\\\\.dlq"})', "{{rabbitmq_queue_name}}")],
                     "short", "Saem com `make requeue-notifications`."), 12, 8)
    b.add(timeseries("Geração de PDF", [
        target("sum(rate(tickets_rendered_total[$__rate_interval]))", "ingressos renderizados/s"),
        target('histogram_quantile(0.95, sum by (le) (rate(ticket_render_duration_seconds_bucket[$__rate_interval])))', "p95 da renderização (s)", "B")]), 12, 7)
    b.add(timeseries("Consumidores por fila", [target("sum by (rabbitmq_queue_name) (rabbitmq_consumer_count)", "{{rabbitmq_queue_name}}")]), 12, 7)
    return b


# ------------------------------------------------------------------ 6. Redis e cache

def redis() -> Board:
    b = Board("lotou-redis", "Redis e cache",
              "Taxa de acerto do cache da página do show, memória, evictions e comandos nos dois Redis (ADR 10).")
    b.row("Cache do event-service")
    b.add(stat("Acerto do cache (5 min)",
               'sum(rate(cache_requests_total{result=~"hit|l1_hit"}[5m])) / sum(rate(cache_requests_total[5m]))', "percentunit", decimals=1,
               steps=[{"color": "red", "value": None}, {"color": "orange", "value": 0.7}, {"color": "green", "value": 0.9}]), 6, 4)
    b.add(stat("Evictions no redis-core", 'sum(increase(redis_keys_evicted_total{server_address="redis-core"}[1h]))', decimals=0, steps=BAD,
               description="Tem que ser zero: o redis-core guarda estoque, assentos e fila, com noeviction."), 6, 4)
    b.add(stat("Memória do redis-cache", 'sum(redis_memory_used_bytes{server_address="redis-cache"})', "bytes"), 6, 4)
    b.add(stat("Memória do redis-core", 'sum(redis_memory_used_bytes{server_address="redis-core"})', "bytes"), 6, 4)
    b.add(timeseries("Cache por prefixo e resultado", [target("sum by (prefix, result) (rate(cache_requests_total[$__rate_interval]))", "{{prefix}} {{result}}")],
                     "reqps", "l1_hit: memória do processo (2 s); hit: redis-cache; miss: MongoDB.", stack=True), 12, 8)
    b.add(timeseries("Taxa de acerto por prefixo", [target(
        'sum by (prefix) (rate(cache_requests_total{result=~"hit|l1_hit"}[$__rate_interval])) / sum by (prefix) (rate(cache_requests_total[$__rate_interval]))', "{{prefix}}")],
        "percentunit"), 12, 8)
    b.row("Redis")
    b.add(timeseries("Comandos por segundo", [target("sum by (server_address) (rate(redis_commands_processed_total[$__rate_interval]))", "{{server_address}}")], "short"), 8, 8)
    b.add(timeseries("Memória usada", [target("sum by (server_address) (redis_memory_used_bytes)", "{{server_address}}")], "bytes"), 8, 8)
    b.add(timeseries("Acertos do keyspace", [target(
        "sum by (server_address) (rate(redis_keyspace_hits_total[$__rate_interval])) / (sum by (server_address) (rate(redis_keyspace_hits_total[$__rate_interval])) + sum by (server_address) (rate(redis_keyspace_misses_total[$__rate_interval])))",
        "{{server_address}}")], "percentunit"), 8, 8)
    b.add(timeseries("Evictions e expirações", [
        target("sum by (server_address) (rate(redis_keys_evicted_total[$__rate_interval]))", "evicted {{server_address}}"),
        target("sum by (server_address) (rate(redis_keys_expired_total[$__rate_interval]))", "expired {{server_address}}", "B")], "short"), 12, 7)
    b.add(timeseries("Clientes conectados", [target("sum by (server_address) (redis_clients_connected)", "{{server_address}}")]), 12, 7)
    return b


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for board in (opening(), gate(), business(), red(), messaging(), redis()):
        path = OUT / f"{board.uid.removeprefix('lotou-')}.json"
        path.write_text(json.dumps(board.json(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{path} ({len(board.panels)} painéis)")
