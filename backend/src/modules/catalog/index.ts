export { prepareCatalog } from "./infrastructure/schema";
export type { CatalogAuthor, CatalogDb, CatalogIntegration, CopyAvailability } from "./domain/CatalogIntegration";
export { Isbn } from "./domain/Isbn";
// export { reconcileBookIndex, syncAuthorBookIndex } from "./infrastructure/bookIndex";
// fase 6: syncAuthorBookIndex também passa a vir de bookVectors
export { syncAuthorBookIndex } from "./infrastructure/bookIndex";
export { reconcileBookIndex } from "./infrastructure/bookVectors";