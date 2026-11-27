"""Pool de processos que geram os PDFs (ingressos e relatório financeiro).

Gerar o PDF é trabalho de CPU (QR code e desenho da página). Num processo
Python, isso travaria o event loop que também consome o Kafka, envia e-mails e
responde ao health check; e uma thread não ajudaria por causa do GIL. Cada PDF
roda então num processo do pool, e o event loop só espera o resultado.

O pool tem um processo por consumidor de `tickets.render` (`RENDER_WORKERS`):
cada consumidor tem prefetch 1, então nunca há mais PDFs em andamento que
processos. Os processos são criados com `spawn`, não `fork`: o processo
principal tem threads (OpenTelemetry, aiokafka), e `fork` com threads pode
travar o filho.
"""

import asyncio
import logging
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

from notification.render.pdf import PdfJob, render_pdf
from notification.render.statement import StatementJob, render_statement

logger = logging.getLogger(__name__)


class RenderFailed(Exception):
    """O processo que gerava o PDF morreu. O pool é recriado; a tarefa vai para a DLQ."""


def _warm_up() -> None:
    """Carrega os módulos no processo filho antes do primeiro ingresso."""


class RenderPool:
    def __init__(self, workers: int) -> None:
        self._workers = workers
        self._executor = self._new_executor()

    def _new_executor(self) -> ProcessPoolExecutor:
        return ProcessPoolExecutor(max_workers=self._workers, mp_context=multiprocessing.get_context("spawn"))

    async def warm_up(self) -> None:
        loop = asyncio.get_running_loop()
        await asyncio.gather(*(loop.run_in_executor(self._executor, _warm_up) for _ in range(self._workers)))

    async def render(self, job: PdfJob) -> bytes:
        return await self._run(job, job.order_id)

    async def statement(self, job: StatementJob) -> bytes:
        return await self._run(job, job.request_id)

    async def _run(self, job: PdfJob | StatementJob, reference: str) -> bytes:
        loop = asyncio.get_running_loop()
        try:
            if isinstance(job, PdfJob):
                return await loop.run_in_executor(self._executor, render_pdf, job)
            return await loop.run_in_executor(self._executor, render_statement, job)
        except BrokenProcessPool as error:
            logger.error("Processo de renderização morreu; recriando o pool", extra={"orderId": reference})
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = self._new_executor()
            raise RenderFailed("o processo que gerava o PDF morreu") from error

    def close(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)
