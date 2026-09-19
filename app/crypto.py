"""Fernet encryption for secrets at rest. The key file is created once and git-ignored."""
import os
from pathlib import Path

from cryptography.fernet import Fernet


class SecretBox:
    def __init__(self, key_path: Path):
        key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not key_path.exists():
            try:
                fd = os.open(str(key_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as f:
                    f.write(Fernet.generate_key())
            except FileExistsError:
                pass
        self._fernet = Fernet(key_path.read_bytes())

    def encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode()).decode()

    def decrypt(self, token: str) -> str:
        return self._fernet.decrypt(token.encode()).decode()


def mask(value: str, keep: int = 4) -> str:
    return "*" * max(0, len(value) - keep) + value[-keep:]
