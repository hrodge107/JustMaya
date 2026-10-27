import os

os.environ.setdefault("META_API_KEY", "test-placeholder-key")
import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"
