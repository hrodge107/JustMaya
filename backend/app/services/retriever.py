from app.config import Settings, load_settings
from app.models.document import SourcePassage, SourceRef
from app.services.vector_store import get_collection


def retrieve(
    document_id: str,
    query: str,
    top_k: int | None = None,
    settings: Settings | None = None,
) -> list[SourcePassage]:
    settings = settings or load_settings()
    collection = get_collection(settings)
    result = collection.query(
        query_texts=[query],
        n_results=top_k or settings.rag_top_k,
        where={"document_id": document_id},
    )
    ids = result["ids"][0]
    documents = result["documents"][0]
    metadatas = result["metadatas"][0]
    distances = (result.get("distances") or [[None] * len(ids)])[0]
    passages = []
    for chunk_id, text, meta, distance in zip(ids, documents, metadatas, distances):
        passages.append(
            SourcePassage(
                chunk_id=chunk_id,
                text=text,
                source=SourceRef(
                    chunk_id=meta["chunk_id"],
                    document_id=meta["document_id"],
                    page_start=meta["page_start"],
                    page_end=meta["page_end"],
                    section_id=meta.get("section_id"),
                ),
                # cosine distance -> relative similarity; a ranking signal,
                # never a correctness claim
                similarity_score=(1.0 - distance) if distance is not None else None,
            )
        )
    return passages
