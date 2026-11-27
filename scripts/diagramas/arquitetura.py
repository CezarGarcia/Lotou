# Gera docs/img/arquitetura.svg: a arquitetura do Lotou em camadas.
# Uso, na raiz: python3 scripts/diagramas/arquitetura.py (precisa do npm ci em apps/web, de onde vêm as fontes).
from html import escape as e
W, H = 1320, 880
BG, CARD, LINE, TEXT, MUTED, YEL = "#121015", "#1C1921", "#332E3A", "#F4EFE6", "#ABA4B5", "#FFD23F"
DISPLAY = "LotouDisplay, Impact, 'Arial Narrow', sans-serif"
BODY = "LotouText, Inter, 'Segoe UI', system-ui, sans-serif"
MONO = "LotouMono, 'DM Mono', ui-monospace, Menlo, monospace"
import base64
ROOT = __import__("pathlib").Path(__file__).resolve().parents[2]
NM = str(ROOT / "apps/web/node_modules") + "/"
def font(name, path, weight):
    data = base64.b64encode(open(NM + path, "rb").read()).decode()
    return f"@font-face{{font-family:{name};font-weight:{weight};src:url(data:font/woff2;base64,{data}) format('woff2')}}"
FONTS = "".join([
    font("LotouDisplay", "@fontsource-variable/big-shoulders-display/files/big-shoulders-display-latin-wght-normal.woff2", "100 900"),
    font("LotouText", "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "100 900"),
    font("LotouMono", "@fontsource/dm-mono/files/dm-mono-latin-500-normal.woff2", "400 500"),
])
STORE = {"Postgres": "#B6A4FF", "MongoDB": "#4FD1A5", "Redis core": "#FF6B6B", "Redis cache": "#FFB86B"}
out = []
def t(x, y, s, size=13, fill=TEXT, family=BODY, weight=400, anchor="start", extra=""):
    out.append(f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" {extra}>{e(s)}</text>')
def box(x, y, w, h, fill=CARD, stroke=LINE, r=14, extra=""):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" {extra}/>')
def arrow(x1, y1, x2, y2, both=False, dash=False, color=MUTED):
    d = ' stroke-dasharray="5 5"' if dash else ""
    ms = ' marker-start="url(#a)"' if both else ""
    out.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="2"{d}{ms} marker-end="url(#a)"/>')
def label(x, y, s):  # rótulo em pílula sobre uma seta
    w = len(s) * 6.6 + 16
    box(x - w / 2, y - 12, w, 22, fill=BG, stroke=LINE, r=11)
    t(x, y + 4, s, 11, MUTED, MONO, anchor="middle")

out.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="titulo desc">')
out.append('<title id="titulo">Arquitetura do Lotou</title>')
out.append('<desc id="desc">O navegador fala com o API Gateway, que encaminha para sete serviços. Os serviços trocam fatos e comandos pelo Kafka; o notification-service usa o RabbitMQ para tarefas. Os dados ficam no Postgres, no MongoDB e em dois Redis. Tudo é observado pelo OpenTelemetry e pelo Grafana.</desc>')
out.append(f'<defs><style>{FONTS}</style><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{MUTED}"/></marker></defs>')
out.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')

# título
out.append(f'<g transform="rotate(-2 92 40)"><rect x="40" y="18" width="104" height="42" fill="{YEL}"/></g>')
t(92, 52, "LOTOU", 34, BG, DISPLAY, 900, "middle")
t(164, 50, "ARQUITETURA", 30, TEXT, DISPLAY, 900)
t(352, 50, "loja, painel do produtor e portaria · nove serviços em Java, Node e Python", 14, MUTED)

# navegador e Keycloak
box(40, 80, 940, 64)
t(60, 108, "NAVEGADOR · ANGULAR", 22, TEXT, DISPLAY, 900)
t(60, 130, "loja, painel do produtor e portaria no celular · SSE na loja, WebSocket no painel", 13, MUTED)
box(1010, 80, 270, 64)
t(1030, 108, "KEYCLOAK", 22, TEXT, DISPLAY, 900)
t(1030, 130, "login OIDC · papéis · tokens JWT", 13, MUTED)
arrow(980, 112, 1008, 112, dash=True)

# gateway
arrow(510, 144, 510, 186)
label(510, 166, "HTTP · SSE · WebSocket")
box(40, 188, 940, 60)
t(60, 216, "API GATEWAY · JAVA", 22, TEXT, DISPLAY, 900)
t(60, 237, "confere o login (JWT) · limita robôs (rate limit no Redis) · encaminha para o serviço certo", 13, MUTED)

# serviços
svcs = [
    ("event", "NODE", ["shows, locais,", "busca e cache"], ["MongoDB", "Redis cache"], True, "both"),
    ("inventory", "JAVA", ["estoque, reservas,", "cadeiras e fila"], ["Redis core", "Postgres"], True, "both"),
    ("order", "JAVA", ["pedidos, cupons,", "saga, reembolso"], ["Postgres"], True, "both"),
    ("payment-mock", "NODE", ["pagamento", "simulado"], ["Postgres"], False, "both"),
    ("checkin", "NODE", ["QR na portaria,", "entrada única"], ["Postgres", "Redis core"], True, "both"),
    ("analytics", "PYTHON", ["painel ao vivo", "e relatórios"], ["MongoDB", "Redis core"], True, "in"),
    ("notification", "PYTHON", ["PDFs com QR", "e e-mails"], ["Redis core"], True, "in"),
]
CW, GAP, SY, SH = 126, 9, 300, 178
for i, (name, lang, role, stores, routed, kafka) in enumerate(svcs):
    x = 40 + i * (CW + GAP)
    cx = x + CW / 2
    if routed:
        arrow(cx, 248, cx, SY - 2)
    box(x, SY, CW, SH)
    t(x + 12, SY + 28, name, 14 if len(name) > 10 else 15, TEXT, BODY, 700)
    t(x + 12, SY + 46, lang, 10.5, YEL, MONO, 500, extra='letter-spacing="1.2"')
    for j, line in enumerate(role):
        t(x + 12, SY + 72 + j * 17, line, 12, MUTED)
    for j, s in enumerate(stores):
        cy = SY + 118 + j * 26
        w = len(s) * 6.7 + 18
        box(x + 12, cy, w, 20, fill=STORE[s], stroke="none", r=10)
        t(x + 12 + w / 2, cy + 14, s, 11, BG, BODY, 600, "middle")
    # Kafka
    if kafka == "both":
        arrow(cx, SY + SH + 2, cx, 528, both=True)
    else:
        arrow(cx, 528, cx, SY + SH + 2)
t(40 + 3 * (CW + GAP) + CW / 2, 280, "só pelo Kafka", 11, MUTED, MONO, anchor="middle")

# RabbitMQ e Mailpit
nx = 40 + 6 * (CW + GAP) + CW
box(1010, 300, 270, 96, fill="#FF4D8D", stroke="none")
t(1030, 332, "RABBITMQ", 24, BG, DISPLAY, 900)
t(1030, 354, "tarefas: PDF, e-mail, relatório", 13, BG, BODY, 600)
t(1030, 374, "tentativas com espera · fila de mortos", 12, BG)
arrow(nx + 2, 336, 1008, 336, both=True)
box(1010, 412, 270, 66)
t(1030, 440, "MAILPIT", 22, TEXT, DISPLAY, 900)
t(1030, 462, "os e-mails enviados (em desenvolvimento)", 12, MUTED)
arrow(nx + 2, 440, 1008, 445)

# Kafka
box(40, 530, 940, 70, fill=YEL, stroke="none")
t(60, 562, "KAFKA", 30, BG, DISPLAY, 900)
t(150, 560, "fatos do domínio e comandos da saga, guardados e relidos", 14, BG, BODY, 700)
t(60, 586, "shows.catalog · order.events · inventory.events · checkin.events · payment.commands/events · inventory.commands · *.dlt", 12, BG, MONO)
t(1030, 548, "SETAS DO KAFKA", 11, MUTED, MONO, 500, extra='letter-spacing="1.2"')
t(1030, 568, "duas pontas: publica e consome", 12, TEXT)
t(1030, 584, "uma ponta: só consome", 12, TEXT)
t(1030, 606, "payment-mock não tem rota no", 12, MUTED)
t(1030, 621, "gateway: só fala pelo Kafka", 12, MUTED)

# dados
t(40, 642, "ONDE OS DADOS FICAM · A COR DE CADA ETIQUETA NOS SERVIÇOS", 11, MUTED, MONO, 500, extra='letter-spacing="1.2"')
stores = [
    ("Postgres", "POSTGRES", ["pedidos, ingressos, cupons", "um banco por serviço"]),
    ("MongoDB", "MONGODB", ["catálogo de shows e locais", "relatórios prontos do produtor"]),
    ("Redis core", "REDIS CORE", ["estoque e cadeiras na venda,", "fila, rate limit · não perde"]),
    ("Redis cache", "REDIS CACHE", ["páginas de show e buscas", "pode perder dados (LRU)"]),
]
for i, (key, title, lines) in enumerate(stores):
    x = 40 + i * 237.5
    box(x, 654, 227.5, 84)
    out.append(f'<rect x="{x}" y="654" width="7" height="84" rx="3" fill="{STORE[key]}"/>')
    t(x + 20, 682, title, 20, STORE[key], DISPLAY, 900)
    for j, line in enumerate(lines):
        t(x + 20, 703 + j * 18, line, 12, MUTED)
box(1010, 654, 270, 84)
t(1030, 678, "PARA VER NO AR", 11, MUTED, MONO, 500, extra='letter-spacing="1.2"')
for j, line in enumerate(["loja :4200 · Grafana :3000", "Kafka UI :8090 · RabbitMQ :15672", "Mailpit :8025 · Keycloak :8180"]):
    t(1030, 698 + j * 17, line, 11.5, TEXT, MONO)

# observabilidade
t(40, 774, "OBSERVABILIDADE · CADA REQUISIÇÃO VIRA UM TRACE, DO CLIQUE AO BANCO", 11, MUTED, MONO, 500, extra='letter-spacing="1.2"')
obs = [("SERVIÇOS E ANGULAR", "OpenTelemetry"), ("OTEL COLLECTOR", "mascara dados pessoais, amostra"),
       ("TEMPO · PROMETHEUS · LOKI", "traces, métricas e logs"), ("GRAFANA", "6 dashboards, 12 alertas, SLOs"),
       ("ALERTAS", "por e-mail no Mailpit")]
bw, g = 230, (1240 - 5 * 230) / 4
for i, (a, b) in enumerate(obs):
    x = 40 + i * (bw + g)
    box(x, 786, bw, 64)
    t(x + 16, 812, a, 17, TEXT, DISPLAY, 900)
    t(x + 16, 834, b, 12, MUTED)
    if i < 4:
        arrow(x + bw + 2, 818, x + bw + g - 2, 818)
out.append("</svg>")
open(ROOT / "docs/img/arquitetura.svg", "w", encoding="utf-8").write("\n".join(out))
