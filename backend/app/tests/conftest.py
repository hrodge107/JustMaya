import os
import sys
from pathlib import Path

os.environ.setdefault("META_API_KEY", "test-placeholder-key")
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import seed_fixtures


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="session", autouse=True)
def fixtures():
    seed_fixtures.seed()
    return seed_fixtures.fixture_path
