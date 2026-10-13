from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

CustomerType = Literal["student", "faculty"]
PlatformRole = Literal["admin"]
OutletRole = Literal["manager", "kitchen_staff"]

# Same limits as the CHECK constraints in supabase/migrations/*_identity.sql.
FullName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Department = Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]
HostelRoom = Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)]


class OutletMembership(BaseModel):
    outlet_id: UUID
    outlet_slug: str
    outlet_name: str
    role: OutletRole


class Me(BaseModel):
    id: UUID
    email: str | None
    full_name: str
    customer_type: CustomerType
    roll_number: str | None
    department: str | None
    year_of_study: int | None
    hostel_room: str | None
    platform_roles: list[PlatformRole]
    outlet_roles: list[OutletMembership]


class ProfileUpdate(BaseModel):
    """Fields a user may change about themselves. Anything else is rejected (422)."""

    model_config = ConfigDict(extra="forbid")

    full_name: FullName | None = None
    department: Department | None = None
    year_of_study: Annotated[int, Field(ge=1, le=8)] | None = None
    hostel_room: HostelRoom | None = None
