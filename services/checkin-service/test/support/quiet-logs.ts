import { Logger } from '@nestjs/common';

// Os avisos de nova tentativa e de DLT são esperados nos testes; no terminal
// só atrapalham a leitura do resultado. TEST_LOGS=1 mostra tudo.
if (!process.env.TEST_LOGS) {
  Logger.overrideLogger(false);
}
