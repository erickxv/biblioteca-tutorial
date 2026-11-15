import { sql } from "../../../infrastructure/postgres";
import type { Embedder } from "../../../shared/Embedder";

/**
 * Índice vetorial dos livros no pgvector. Uma linha por livro, com o texto
 * indexado e o vetor. Tudo aqui é derivado de `livros`: pode ser apagado e
 * reconstruído a qualquer momento.
 */
const TABLE = "livros_vetores";
/** O limite do índice HNSW para o tipo `vector`. */
const MAX_HNSW_DIMENSIONS = 2000;
/** Lock próprio do DDL. O 22001 é o das escritas (transaction.ts) e não deve ser reaproveitado. */
const DDL_LOCK = 22002;

/**
 * Garante que a tabela e o índice existem para este embedder e diz se precisou
 * (re)criá-los. Vetores de outro modelo não se comparam com os deste: trocar de
 * modelo ou de dimensão apaga a tabela e começa de novo.
 */
export async function ensureBookIndex(embedder: Embedder): Promise<boolean> {
  const dimensions = embedder.dimensions;
  // o número vai cru para o DDL (sql.unsafe): só entra depois de validado
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_HNSW_DIMENSIONS) {
    throw new Error(`Dimensão inválida: ${dimensions}`);
  }

  return await sql.begin(async (tx) => {
    // duas requisições chegando juntas não recriam a tabela uma por cima da outra
    await tx`SELECT pg_advisory_xact_lock(${DDL_LOCK})`;

    const [column] = await tx`
      SELECT format_type(atttypid, atttypmod) AS type
      FROM pg_attribute
      WHERE attrelid = to_regclass('livros_vetores') AND attname = 'embedding'
    ` as { type: string }[];

    if (column) {
      const [otherModel] = await tx`
        SELECT 1 AS found FROM livros_vetores WHERE modelo <> ${embedder.id} LIMIT 1
      ` as { found: number }[];
      if (column.type === `vector(${dimensions})` && !otherModel) return false;
    }

    await tx.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await tx.unsafe(`
      CREATE TABLE ${TABLE} (
        livro_id INTEGER PRIMARY KEY REFERENCES livros(id) ON DELETE CASCADE,
        texto TEXT NOT NULL,
        modelo TEXT NOT NULL,
        embedding vector(${dimensions}) NOT NULL
      )
    `);
    await tx.unsafe(`
      CREATE INDEX ${TABLE}_embedding_idx ON ${TABLE} USING hnsw (embedding vector_cosine_ops)
    `);
    return true;
  }) as boolean;
}