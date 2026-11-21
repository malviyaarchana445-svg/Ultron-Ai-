# Ultron AI Firestore Security Specification

## 1. Data Invariants
1. **Strict Ownership**: Every document under `users/{userId}` and its subcollections (`chats`, `memories`, `workspace`, `agents`, `files`, `images`, `videos`) belongs exclusively to `request.auth.uid == userId`. No user can read, list, create, update, or delete another user's data.
2. **Parent Gate Integrity**: All subcollection `get`, `create`, `update`, and `delete` operations require that the parent `users/{userId}` document exists and its `uid` equals `request.auth.uid`.
3. **Cost-Optimized List Queries**: Subcollection `allow list` rules check `isOwner(userId)` and `resource.data.userId == request.auth.uid` without `get()`/`exists()`, requiring clients to filter queries by `where('userId', '==', uid)`.
4. **Immutable Identity & Creation Timestamps**: `uid`, `userId`, document `id`/`chatId`, and `createdAt` cannot be mutated after creation. `createdAt` and `updatedAt` are strictly enforced against `request.time`.
5. **No Password or API Secret Storage**: Passwords are handled exclusively by Firebase Authentication SDK, and LLM API keys are never persisted in Firestore (`hasOnly` rejects unknown fields).
6. **Bounded Payloads**: All path/record IDs match `^[a-zA-Z0-9_\-]+$` (`<= 128` chars), strings have explicit `.size()` bounds, and list fields (`messages`, `tags`, `tools`) are strictly bounded to prevent document exhaustion.

## 2. Adversarial "Dirty Dozen" Payloads (All Must Return PERMISSION_DENIED)
1. **Cross-user profile read**: Authenticated as `userA`, `get(/users/userB)` -> DENIED.
2. **Cross-user subcollection read**: Authenticated as `userA`, `get(/users/userB/workspace/w1)` -> DENIED.
3. **User directory scraping**: Authenticated as `userA`, `list(/users)` -> DENIED.
4. **UID spoofing in subcollection**: Authenticated as `userA`, `create(/users/userA/memories/m1, { userId: 'userB', ... })` -> DENIED.
5. **Ghost / shadow field injection (e.g. password, apiKey, or isAdmin)**: `create(/users/userA, { uid: 'userA', ..., isAdmin: true })` -> DENIED by `hasOnly`.
6. **Unauthenticated read/write**: `request.auth == null` on `/users/userA/agents/a1` -> DENIED.
7. **ID poisoning (1.5KB path ID)**: `create(/users/userA/files/<1500 chars>)` -> DENIED by `isValidId()`.
8. **Invalid ID characters**: `create(/users/userA/chats/chat$bad!)` -> DENIED by regex `^[a-zA-Z0-9_\-]+$`.
9. **Timestamp tampering on create**: `create(/users/userA/videos/v1, { createdAt: <past_time> })` -> DENIED by `createdAt == request.time`.
10. **Immutable field mutation on update**: `update(/users/userA/workspace/w1, { createdAt: request.time, userId: 'other' })` -> DENIED by immutability & `affectedKeys().hasOnly(...)`.
11. **Cross-user subcollection list query**: Authenticated as `userA`, `list(/users/userB/images)` -> DENIED.
12. **Oversized content or array DoS**: `create(/users/userA/memories/m1, { fact: <5000 chars> })` -> DENIED by `.size()` bounds.
