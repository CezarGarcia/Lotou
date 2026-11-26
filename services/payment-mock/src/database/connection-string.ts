/**
 * A URL de conexão com a senha de `DATABASE_PASSWORD`, quando ela vem à parte
 * (assim a senha não precisa estar escrita na URL do Compose).
 *
 * A senha entra na URL, e não na opção `password` do `pg`: o driver deixa o
 * que vem da `connectionString` valer por cima das outras opções, e uma URL
 * sem senha apagaria a informada.
 */
export function connectionString(url: string, password?: string): string {
  if (!password) {
    return url;
  }
  const parsed = new URL(url);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}
