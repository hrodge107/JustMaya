import tiktoken
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import Settings, load_settings
from app.models.document import ExtractedDocument, SourceChunk
from app.services.vector_store import get_collection

# ponytail: cl100k_base is a conservative proxy for MiniLM wordpieces;
# keep rag_chunk_tokens <= ~200 or switch to the real tokenizer
_encoding = tiktoken.get_encoding("cl100k_base")


def _token_len(text: str) -> int:
    return len(_encoding.encode(text))


def chunk_document(
    extracted: ExtractedDocument, chunk_tokens: int, chunk_overlap: int
) -> list[SourceChunk]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_tokens,
        chunk_overlap=chunk_overlap,
        length_function=_token_len,
    )
    section_for_page = {
        page: section.section_id
        for section in extracted.sections
        for page in range(section.page_start, section.page_end + 1)
    }
    chunks: list[SourceChunk] = []
    for page in extracted.pages:
        if not page.text.strip():
            continue
        for seq, piece in enumerate(splitter.split_text(page.text)):
            chunks.append(
                SourceChunk(
                    chunk_id=f"{extracted.document_id}-p{page.page_number:04d}-{seq}",
                    document_id=extracted.document_id,
                    text=piece,
                    page_start=page.page_number,
                    page_end=page.page_number,
                    section_id=section_for_page.get(page.page_number),
                )
            )
    return chunks


def _metadata(chunk: SourceChunk) -> dict:
    meta = {
        "chunk_id": chunk.chunk_id,
        "document_id": chunk.document_id,
        "page_start": chunk.page_start,
        "page_end": chunk.page_end,
    }
    if chunk.section_id:
        meta["section_id"] = chunk.section_id
    return meta


def index_document(
    extracted: ExtractedDocument, settings: Settings | None = None
) -> int:
    settings = settings or load_settings()
    chunks = chunk_document(
        extracted, settings.rag_chunk_tokens, settings.rag_chunk_overlap
    )
    collection = get_collection(settings)
    collection.delete(where={"document_id": extracted.document_id})
    if chunks:
        collection.upsert(
            ids=[c.chunk_id for c in chunks],
            documents=[c.text for c in chunks],
            metadatas=[_metadata(c) for c in chunks],
        )
    return len(chunks)
