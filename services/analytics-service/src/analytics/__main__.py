"""Sobe o serviço: `python -m analytics`."""

import uvicorn

from analytics.api.app import create_app
from analytics.config import Settings
from analytics.telemetry import setup


def main() -> None:
    settings = Settings()  # vem das variáveis de ambiente
    telemetry = setup(settings)
    app = create_app(settings, telemetry=telemetry)
    # Os logs do uvicorn passam pelo formatter JSON; cada requisição já vira um span HTTP.
    # WebSocket do painel: ping de protocolo a cada 20 s (fecha se o pong não vier em
    # 20 s) e mensagens do cliente pequenas (o token é a maior).
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=settings.port,
        log_config=None,
        access_log=False,
        ws_ping_interval=20.0,
        ws_ping_timeout=20.0,
        ws_max_size=64 * 1024,
    )


if __name__ == "__main__":
    main()
