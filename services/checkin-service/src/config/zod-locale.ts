import { z } from 'zod';

// Mensagens de validação em português: elas chegam ao cliente da API.
z.config(z.locales.ptBR());
