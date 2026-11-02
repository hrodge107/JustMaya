"""Download the pinned optional Kokoro model/voices. No downloads at app startup."""
import hashlib
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import load_settings

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = {
    "kokoro-v1.0.int8.onnx": "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    target = load_settings().speech_model_dir.resolve()
    target.mkdir(parents=True, exist_ok=True)
    for name, expected in FILES.items():
        path = target / name
        if path.exists() and digest(path) == expected:
            print(f"Verified {name}", flush=True)
            continue
        partial = target / (name + ".partial")
        print(f"Downloading {name}...", flush=True)
        try:
            with urllib.request.urlopen(RELEASE + name, timeout=60) as source, partial.open("wb") as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
            if digest(partial) != expected:
                raise RuntimeError(f"Checksum mismatch for {name}; retry the setup.")
            partial.replace(path)
        finally:
            partial.unlink(missing_ok=True)
    print(f"Speech models ready: {target}")


if __name__ == "__main__":
    main()
