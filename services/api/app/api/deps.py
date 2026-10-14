"""Shared FastAPI dependency aliases for route handlers."""

from typing import Annotated

from fastapi import Depends

from app.core.auth import Principal, current_principal
from app.core.db import Database, get_database

CurrentPrincipal = Annotated[Principal, Depends(current_principal)]
Db = Annotated[Database, Depends(get_database)]
