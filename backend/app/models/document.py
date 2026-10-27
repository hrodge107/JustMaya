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
