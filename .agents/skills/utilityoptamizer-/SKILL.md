---
name: utilityoptamizer-conventions
description: Development conventions and patterns for utilityoptamizer-. TypeScript project with freeform commits.
---

# Utilityoptamizer Conventions

> Generated from [leoideate/utilityoptamizer-](https://github.com/leoideate/utilityoptamizer-) on 2026-10-17

## Overview

This skill teaches Claude the development patterns and conventions used in utilityoptamizer-.

## Tech Stack

- **Primary Language**: TypeScript
- **Architecture**: type-based module organization
- **Test Location**: mixed
- **Test Framework**: jest

## When to Use This Skill

Activate this skill when:
- Making changes to this repository
- Adding new features following established patterns
- Writing tests that match project conventions
- Creating commits with proper message format

## Commit Conventions

Follow these commit message conventions based on 10 analyzed commits.

### Commit Style: Free-form Messages

### Message Guidelines

- Average message length: ~54 characters
- Keep first line concise and descriptive
- Use imperative mood ("Add feature" not "Added feature")


*Commit message example*

```text
Auto-label generic PDF form fields from nearby page text
```

*Commit message example*

```text
Switch the web app to Material Design (AWC UI) with the Utility Optimizer logo
```

*Commit message example*

```text
Give sales and the back office their own interfaces
```

*Commit message example*

```text
Add change-of-entity and existing-supplier renewal workflows
```

*Commit message example*

```text
Add supplier PDF forms, signature upload and change-of-supplier checks
```

*Commit message example*

```text
Add onboarding fields from the Odoo lead form
```

*Commit message example*

```text
Harden security after penetration and stress testing
```

*Commit message example*

```text
Make every screen work from 320px phones to 1920px monitors
```

## Architecture

### Project Structure: Monorepo

This project uses **type-based** module organization.

### Configuration Files

- `apps/api/Dockerfile`
- `apps/api/jest.config.js`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/web/Dockerfile`
- `apps/web/next.config.ts`
- `apps/web/package.json`
- `apps/web/playwright.config.ts`
- `apps/web/tsconfig.json`
- `docker-compose.yml`
- `package.json`
- `packages/shared/jest.config.js`
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`

### Guidelines

- Group code by type (components, services, utils)
- Keep related functionality in the same type folder
- Avoid circular dependencies between type folders

## Code Style

### Language: TypeScript

### Naming Conventions

| Element | Convention |
|---------|------------|
| Files | camelCase |
| Functions | camelCase |
| Classes | PascalCase |
| Constants | SCREAMING_SNAKE_CASE |

### Import Style: Relative Imports

### Export Style: Named Exports


*Preferred import style*

```typescript
// Use relative imports
import { Button } from '../components/Button'
import { useAuth } from './hooks/useAuth'
```

*Preferred export style*

```typescript
// Use named exports
export function calculateTotal() { ... }
export const TAX_RATE = 0.1
export interface Order { ... }
```

## Testing

### Test Framework: jest

### File Pattern: `*.test.ts`

### Test Types

- **Unit tests**: Test individual functions and components in isolation
- **Integration tests**: Test interactions between multiple components/services
- **E2e tests**: Test complete user flows through the application


*Test file structure*

```typescript
import { describe, it, expect } from 'jest'

describe('MyFunction', () => {
  it('should return expected result', () => {
    const result = myFunction(input)
    expect(result).toBe(expected)
  })
})
```

## Error Handling

### Error Handling Style: Try-Catch Blocks

This project uses **custom error classes** for specific error types.


*Standard error handling pattern*

```typescript
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  console.error('Operation failed:', error)
  throw new Error('User-friendly message')
}
```

## Common Workflows

These workflows were detected from analyzing commit patterns.

### Database Migration

Database schema changes with migration files

**Frequency**: ~18 times per month

**Steps**:
1. Create migration file
2. Update schema definitions
3. Generate/update types

**Files typically involved**:
- `migrations/*`
- `**/schema.*`
- `**/types.ts`

**Example commit sequence**:
```
Add Utility Optimizer CRM
Add internal chat and RingCentral click-to-call
Make every screen work from 320px phones to 1920px monitors
```

### Feature Development

Standard feature implementation workflow

**Frequency**: ~15 times per month

**Steps**:
1. Add feature implementation
2. Add tests for feature
3. Update documentation

**Files typically involved**:
- `apps/api/prisma/*`
- `apps/api/scripts/*`
- `apps/api/src/activities/*`
- `**/*.test.*`
- `**/api/**`

**Example commit sequence**:
```
Add Utility Optimizer CRM
Add internal chat and RingCentral click-to-call
Make every screen work from 320px phones to 1920px monitors
```


## Best Practices

Based on analysis of the codebase, follow these practices:

### Do

- Write tests using jest
- Follow *.test.ts naming pattern
- Use camelCase for file names
- Prefer named exports

### Don't

- Don't skip tests for new features
- Don't deviate from established patterns without discussion

---

*This skill was auto-generated by [ECC Tools](https://ecc.tools). Review and customize as needed for your team.*
