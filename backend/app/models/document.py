from pydantic import BaseModel


class DocumentRecord(BaseModel):
    documentId: str
    filename: str
    status: str  # "uploaded" | "processing" | "ready" | "failed"
    pageCount: int | None = None
    errorCode: str | None = None
    createdAt: str


class UploadResponse(BaseModel):
    document_id: str
    job_id: str
    status: str


class JobStatusResponse(BaseModel):
    job_id: str
    document_id: str
    status: str
    stage: str | None = None
    error: str | None = None
    execution_state: str | None = None
    can_run: bool = False
    token_usage: dict = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cached_tokens": 0,
        "total_tokens": 0,
        "by_stage": {},
    }


class DocumentPage(BaseModel):
    document_id: str
    page_number: int  # 1-based
    text: str
    flags: list[str] = []  # "no_text", "image_only"
    char_count: int = 0


class DocumentSection(BaseModel):
    section_id: str
    title: str
    page_start: int
    page_end: int


class ExtractedDocument(BaseModel):
    document_id: str
    page_count: int
    pages: list[DocumentPage]
    sections: list[DocumentSection] = []
    image_only_document: bool = False


class SourceRef(BaseModel):
    chunk_id: str
    document_id: str
    page_start: int  # 1-based
    page_end: int  # 1-based
    section_id: str | None = None


class SourcePassage(BaseModel):
    chunk_id: str
    text: str
    source: SourceRef
    similarity_score: float | None = None


class SourceChunk(BaseModel):
    chunk_id: str
    document_id: str
    text: str
    page_start: int  # 1-based
    page_end: int  # 1-based
    section_id: str | None = None
