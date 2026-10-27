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
