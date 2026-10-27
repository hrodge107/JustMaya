from functools import lru_cache

import chromadb
from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2

from app.config import Settings

COLLECTION_NAME = "source_chunks"


@lru_cache(maxsize=1)
def _embedding_fn() -> ONNXMiniLM_L6_V2:
    # downloads the ONNX model (~80MB) on first embed call, then cached on disk
    return ONNXMiniLM_L6_V2()


def get_collection(settings: Settings):
    settings.chroma_dir.mkdir(parents=True, exist_ok=True)
    client = chromadb.PersistentClient(path=str(settings.chroma_dir))
    return client.get_or_create_collection(
        COLLECTION_NAME,
        embedding_function=_embedding_fn(),
        metadata={"hnsw:space": "cosine"},
    )
