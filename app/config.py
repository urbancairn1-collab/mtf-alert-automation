"""Process configuration. Values can be overridden with MTF_* environment variables."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class AppConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MTF_", env_file=".env", extra="ignore")

    data_dir: Path = Path("data")
    dashboard_port: int = 8000
    webhook_port: int = 8001
    ngrok_api: str = "http://127.0.0.1:4040/api/tunnels"
    scrip_master_url: str = (
        "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
    )
    version: str = "1.0.0"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "app.db"

    @property
    def key_path(self) -> Path:
        return self.data_dir / "secret.key"

    @property
    def log_dir(self) -> Path:
        return self.data_dir / "logs"


@lru_cache(maxsize=1)
def get_config() -> AppConfig:
    cfg = AppConfig()
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    cfg.log_dir.mkdir(parents=True, exist_ok=True)
    return cfg
