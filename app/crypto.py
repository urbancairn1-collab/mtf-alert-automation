"""Fernet encryption for secrets at rest. The key file is created once and git-ignored."""
from pathlib import Path

from cryptography.fernet import Fernet


class SecretBox:
    def __init__(self, key_path: Path):
        key_path.parent.mkdir(parents=True, exist_ok=True)
        if not key_path.exists():
            key_path.write_bytes(Fernet.generate_key())
        self._fernet = Fernet(key_path.read_bytes())

    def encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode()).decode()

    def decrypt(self, token: str) -> str:
        return self._fernet.decrypt(token.encode()).decode()


def mask(value: str, keep: int = 4) -> str:
    return "*" * max(0, len(value) - keep) + value[-keep:]
