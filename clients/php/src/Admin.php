<?php

declare(strict_types=1);

namespace Novamem;

use Novamem\Types as T;

/**
 * Server administration, with an admin user's bearer: provisioning one
 * novamem user per agent, and revoking leaked tokens.
 */
final class Admin extends Base
{
    public function provisionUser(
        T\ProvisionUserRequest $request,
    ): T\ProvisionedUser {
        if (self::blank($request->email) || $request->password === "") {
            throw new NovamemException(
                "provision-user",
                "email and password are required",
            );
        }
        return T\ProvisionedUser::fromArray(
            $this->t->call(
                "provision-user",
                "POST",
                "/v1/admin/users",
                $request->toArray(),
            ),
        );
    }

    /** Revoke a bearer by presenting its plaintext. */
    public function revokeUserToken(
        #[\SensitiveParameter] string $token,
    ): T\RevokeResult {
        if (self::blank($token)) {
            throw new NovamemException(
                "revoke-user-token",
                "token is required",
            );
        }
        return T\RevokeResult::fromArray(
            $this->t->call(
                "revoke-user-token",
                "POST",
                "/v1/admin/tokens/revoke",
                ["token" => $token],
            ),
        );
    }

    public function listUsers(): T\AdminUserList
    {
        return T\AdminUserList::fromArray(
            $this->t->call("list-users", "GET", "/v1/admin/users"),
        );
    }

    public function previewDeleteUser(string $id): T\UserDeletionPreview
    {
        if (self::blank($id)) {
            throw new NovamemException(
                "preview-delete-user",
                "userID is required",
            );
        }
        return T\UserDeletionPreview::fromArray(
            $this->t->call(
                "preview-delete-user",
                "DELETE",
                "/v1/admin/users/" . self::seg($id),
                query: ["dryRun" => "true"],
            ),
        );
    }

    public function deleteUser(string $id): T\UserDeletion
    {
        if (self::blank($id)) {
            throw new NovamemException("delete-user", "userID is required");
        }
        return T\UserDeletion::fromArray(
            $this->t->call(
                "delete-user",
                "DELETE",
                "/v1/admin/users/" . self::seg($id),
            ),
        );
    }

    /** null clears that override (it is sent as JSON null). */
    public function setUserQuota(
        string $id,
        ?int $maxEntries = null,
        ?int $writesPerMinute = null,
    ): T\QuotaResult {
        if (self::blank($id)) {
            throw new NovamemException("set-user-quota", "userID is required");
        }
        return T\QuotaResult::fromArray(
            $this->t->call(
                "set-user-quota",
                "PUT",
                "/v1/admin/users/" . self::seg($id) . "/quota",
                [
                    "maxEntries" => $maxEntries,
                    "writesPerMinute" => $writesPerMinute,
                ],
            ),
        );
    }
}
