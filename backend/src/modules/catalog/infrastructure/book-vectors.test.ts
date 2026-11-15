import { expect, test } from "bun:test";
import "#tests/api";
import { createHashEmbedder } from "../../../infrastructure/hashEmbedder";
import { sql } from "../../../infrastructure/postgres";
import { ensureBookIndex } from "./bookVectors";

async function columnType(): Promise<string | undefined> {
  const [row] = await sql`
    SELECT format_type(atttypid, atttypmod) AS type
    FROM pg_attribute
    WHERE attrelid = to_regclass('livros_vetores') AND attname = 'embedding'
  ` as { type: string }[];
  return row?.type;
}

test("pgvector: a tabela nasce com a dimensão do embedder e o ensure é idempotente", async () => {
  const embedder = createHashEmbedder();
  await ensureBookIndex(embedder);
  expect(await columnType()).toBe("vector(1024)");
  expect(await ensureBookIndex(embedder)).toBe(false);
});

test("pgvector: um embedder de outra dimensão refaz a tabela", async () => {
  try {
    expect(await ensureBookIndex(createHashEmbedder(512))).toBe(true);
    expect(await columnType()).toBe("vector(512)");
  } finally {
    // armadilha 4: devolve o banco de testes ao estado que os outros testes esperam
    await ensureBookIndex(createHashEmbedder());
  }
  expect(await columnType()).toBe("vector(1024)");
});