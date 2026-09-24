---
name: nestjs-api
description: Create NestJS API endpoints with controllers, services, and modules. Use when adding API routes, backend features, validation, or any backend code change. This is the backend framework — every API change should follow NestJS patterns.
---

# NestJS API Development

The backend uses NestJS with the Fastify adapter. All routes are prefixed with `/api` (set in `main.ts`). For real-time features (live updates, chat, server push) see the `websockets` skill.

## Module pattern — every feature needs 3 files

### 1. Module

```typescript
import { Module } from "@nestjs/common"
import { TasksController } from "./tasks.controller"
import { TasksService } from "./tasks.service"

@Module({
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
```

### 2. Controller (handles HTTP)

```typescript
import { Controller, Get, Post, Put, Delete, Param, Body, Query, ParseIntPipe, BadRequestException } from "@nestjs/common"
import { TasksService } from "./tasks.service"

@Controller("tasks")
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  findAll(@Query("status") status?: string) {
    return this.tasksService.findAll(status)
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.tasksService.findOne(id)
  }

  @Post()
  create(@Body() body: { title: string; description?: string }) {
    if (!body.title) throw new BadRequestException("Title is required")
    return this.tasksService.create(body.title, body.description)
  }

  @Put(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() body: { title?: string; description?: string; status?: string }) {
    return this.tasksService.update(id, body)
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    this.tasksService.remove(id)
    return { ok: true }
  }
}
```

### 3. Service (business logic + database)

```typescript
import { Injectable, NotFoundException } from "@nestjs/common"
import { DatabaseService } from "../database/database.service"

@Injectable()
export class TasksService {
  constructor(private readonly db: DatabaseService) {}

  findAll(status?: string) {
    if (status) {
      return this.db.queryAll("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC", [status])
    }
    return this.db.queryAll("SELECT * FROM tasks ORDER BY created_at DESC")
  }

  findOne(id: number) {
    const task = this.db.queryOne("SELECT * FROM tasks WHERE id = ?", [id])
    if (!task) throw new NotFoundException(`Task ${id} not found`)
    return task
  }

  create(title: string, description?: string) {
    const result = this.db.run("INSERT INTO tasks (title, description) VALUES (?, ?)", [title, description ?? null])
    return this.findOne(result.lastInsertRowid as number)
  }

  update(id: number, data: { title?: string; description?: string; status?: string }) {
    this.findOne(id)
    this.db.run(
      "UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status), updated_at = datetime('now') WHERE id = ?",
      [data.title ?? null, data.description ?? null, data.status ?? null, id],
    )
    return this.findOne(id)
  }

  remove(id: number) {
    this.findOne(id)
    this.db.run("DELETE FROM tasks WHERE id = ?", [id])
  }
}
```

Name every column an update may touch — never build SQL from the request body's keys, which lets a client write any column. Register the module in `app.module.ts` (`web-app`).

## DatabaseService methods

`queryAll`, `queryOne`, `run` and `exec` are the whole API — the `sqlite` skill has their signatures and transactions.

## Key decorators

- `@Controller("path")` — route prefix
- `@Get()`, `@Post()`, `@Put()`, `@Delete()` — HTTP methods
- `@Param("name", ParseIntPipe)` — URL params with type coercion
- `@Body()` — request body
- `@Query("name")` — query string params

## Exceptions

- `NotFoundException` → 404
- `BadRequestException` → 400
- `UnauthorizedException` → 401
- `ForbiddenException` → 403
- `ConflictException` → 409
