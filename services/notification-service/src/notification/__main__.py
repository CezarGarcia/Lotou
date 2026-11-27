"""Sobe o serviço: `python -m notification` (API, consumidor do Kafka e workers)."""

import uvicorn

from notification.api.app import create_app
from notification.config import Settings
from notification.telemetry import setup


def main() -> None:
    settings = Settings()  # vem das variáveis de ambiente
    telemetry = setup(settings)
    app = create_app(settings, telemetry=telemetry)
    # SIGTERM (docker stop) chega ao uvicorn, que roda o fim do lifespan: o
    # consumidor do Kafka para, os workers terminam o que têm em mãos e as
    # conexões fecham. O que não terminar no prazo volta para a fila.
    uvicorn.run(app, host="0.0.0.0", port=settings.port, log_config=None, access_log=False)


if __name__ == "__main__":
    main()
