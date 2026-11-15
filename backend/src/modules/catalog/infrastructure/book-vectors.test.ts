import { expect, test } from "bun:test";
import "#tests/api";
import { createHashEmbedder } from "../../../infrastructure/hashEmbedder";
import { sql } from "../../../infrastructure/postgres";
import { ensureBookIndex } from "./bookVectors";
import { api, testAuthor, testIsbn } from "#tests/api";
import { catalogIntegration } from "../../../integration/catalogIntegration";
import type { Embedder } from "../../../shared/Embedder";
import { reconcileBookIndex, syncAuthorBookIndex, syncBookIndex } from "./bookVectors";

// testes parte 2

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

// testes parte 3

const hash = createHashEmbedder();

async function createBook(title: string, authorId: number): Promise<{ id: number; isbn: string }> {
  const response = await api("POST", "/livros", { isbn: testIsbn(), titulo: title, autorId: authorId });
  expect(response.status).toBe(201);
  return response.json();
}

async function storedRow(id: number): Promise<{ text: string; model: string; dims: number } | undefined> {
  const [row] = await sql`
    SELECT texto AS text, modelo AS model, vector_dims(embedding) AS dims
    FROM livros_vetores WHERE livro_id = ${id}
  ` as { text: string; model: string; dims: number }[];
  return row;
}

const title = () => `Livro ${crypto.randomUUID().slice(0, 8)}`;

test("pgvector: sincronizar grava o texto \"Título — Autor\" e um vetor da dimensão do embedder", async () => {
  const author = await testAuthor();
  const t = title();
  const book = await createBook(t, author.id);
  expect(await syncBookIndex([book.id], catalogIntegration, hash)).toEqual({ indexed: 1, removed: 0 });
  expect(await storedRow(book.id)).toEqual({ text: `${t} — ${author.nome}`, model: hash.id, dims: hash.dimensions });
});

test("pgvector: editar o título atualiza texto e vetor", async () => {
  const author = await testAuthor();
  const book = await createBook(title(), author.id);
  await syncBookIndex([book.id], catalogIntegration, hash);
  const novo = `Novo título ${crypto.randomUUID().slice(0, 8)}`;
  expect((await api("PUT", `/livros/${book.id}`, { isbn: book.isbn, titulo: novo, autorId: author.id })).status).toBe(200);
  expect(await syncBookIndex([book.id], catalogIntegration, hash)).toEqual({ indexed: 1, removed: 0 });
  expect((await storedRow(book.id))?.text).toBe(`${novo} — ${author.nome}`);
});

test("pgvector: excluir o livro leva a linha junto (CASCADE)", async () => {
  const author = await testAuthor();
  const book = await createBook(title(), author.id);
  await syncBookIndex([book.id], catalogIntegration, hash);
  expect(await storedRow(book.id)).toBeDefined();
  expect((await api("DELETE", `/livros/${book.id}`)).status).toBe(204);
  expect(await storedRow(book.id)).toBeUndefined();
});

test("pgvector: renomear o autor atualiza o texto dos livros dele", async () => {
  const author = await testAuthor();
  const book = await createBook(title(), author.id);
  await syncBookIndex([book.id], catalogIntegration, hash);
  const nome = `Autora ${crypto.randomUUID().slice(0, 8)}`;
  expect((await api("PUT", `/autores/${author.id}`, { nome, tipo: "literatura" })).status).toBe(200);
  await syncAuthorBookIndex(author.id, catalogIntegration);
  expect((await storedRow(book.id))?.text).toEndWith(`— ${nome}`);
});

test("pgvector: livro inserido direto por SQL, como faz o seed, ganha vetor na reconciliação", async () => {
  const author = await testAuthor();
  const [row] = await sql`
    INSERT INTO livros (isbn, titulo, autor_id, data_catalogacao)
    VALUES (${testIsbn()}, ${title()}, ${author.id}, '2026-01-01') RETURNING id
  ` as { id: number }[];
  await reconcileBookIndex(catalogIntegration, hash);
  expect(await storedRow(row!.id)).toBeDefined();
});

test("pgvector: sincronizar de novo com o texto igual não chama o embedder", async () => {
  const author = await testAuthor();
  const book = await createBook(title(), author.id);
  let calls = 0;
  const counter: Embedder = { ...hash, embed: (texts, purpose) => { calls++; return hash.embed(texts, purpose); } };
  await syncBookIndex([book.id], catalogIntegration, counter);
  expect(calls).toBe(1);
  expect(await syncBookIndex([book.id], catalogIntegration, counter)).toEqual({ indexed: 0, removed: 0 });
  expect(calls).toBe(1);
});

test("pgvector: com o embedder fora do ar a sincronização não lança", async () => {
  const author = await testAuthor();
  const book = await createBook(title(), author.id);
  // mesmo id e mesma dimensão: senão o ensure acharia que o modelo mudou e recriaria a tabela
  const foraDoAr: Embedder = { ...hash, embed: async () => { throw new Error("fora do ar"); } };
  expect(await syncBookIndex([book.id], catalogIntegration, foraDoAr)).toEqual({ indexed: 0, removed: 0 });
  expect(await storedRow(book.id)).toBeUndefined();
});

test("pgvector: trocar de embedder refaz a tabela e os livros voltam a ter vetor", async () => {
  const author = await testAuthor();
  const book = await createBook(title(), author.id);
  try {
    await syncBookIndex([book.id], catalogIntegration, createHashEmbedder(512));
    expect((await storedRow(book.id))?.dims).toBe(512);
  } finally {
    // armadilha 4: devolve o banco de testes ao estado que os outros testes esperam
    await reconcileBookIndex(catalogIntegration, hash);
  }
  expect((await storedRow(book.id))?.dims).toBe(hash.dimensions);
});