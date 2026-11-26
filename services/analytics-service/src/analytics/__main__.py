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
    uvicorn.run(app, host="0.0.0.0", port=settings.port, log_config=None, access_log=False)


if __name__ == "__main__":
    main()
