from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg2://motion:motion_pass@localhost:5432/motion"
    redis_url: str = "redis://localhost:6379/0"
    data_root: str = "/data"
    # 维度化原始仓库根目录（data/{modality}/{ontology}/{format}/{source}/）
    hub_repo_root: str = "/hub_repo"
    secret_key: str = "dev_secret_key"
    token_expire_hours: int = 24 * 7
    admin_username: str = "admin"
    admin_password: str = "admin123"
    duration_tolerance_sec: float = 0.15


settings = Settings()
