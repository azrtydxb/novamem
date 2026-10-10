package com.azrtydxb.novamem;

import com.azrtydxb.novamem.types.Types.AdminUserList;
import com.azrtydxb.novamem.types.Types.ProvisionUserRequest;
import com.azrtydxb.novamem.types.Types.ProvisionedUser;
import com.azrtydxb.novamem.types.Types.QuotaResult;
import com.azrtydxb.novamem.types.Types.RevokeResult;
import com.azrtydxb.novamem.types.Types.UserDeletion;
import com.azrtydxb.novamem.types.Types.UserDeletionPreview;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Server administration, with an admin user's bearer: provisioning one novamem user per agent, and
 * revoking leaked tokens. Every operation has a blocking and an {@code …Async} form.
 */
public final class Admin extends Base {
  /**
   * An admin client for the given config.
   *
   * @throws IllegalArgumentException when config is null
   */
  public Admin(NovamemConfig config) {
    super(config);
  }

  /** Creates a user and mints their first token. */
  public ProvisionedUser provisionUser(ProvisionUserRequest request) {
    return await(provisionUserAsync(request));
  }

  /** See {@link #provisionUser}. */
  public CompletableFuture<ProvisionedUser> provisionUserAsync(ProvisionUserRequest request) {
    if (request == null
        || blank(request.email())
        || request.password() == null
        || request.password().isEmpty()) {
      return invalid("provision-user", "email and password are required");
    }
    return as(
        "provision-user",
        transport.call("provision-user", "POST", "/v1/admin/users", request, null, true),
        ProvisionedUser.class,
        false);
  }

  /** Revoke a bearer by presenting its plaintext. */
  public RevokeResult revokeUserToken(String token) {
    return await(revokeUserTokenAsync(token));
  }

  /** See {@link #revokeUserToken}. */
  public CompletableFuture<RevokeResult> revokeUserTokenAsync(String token) {
    if (blank(token)) {
      return invalid("revoke-user-token", "token is required");
    }
    return as(
        "revoke-user-token",
        transport.call(
            "revoke-user-token",
            "POST",
            "/v1/admin/tokens/revoke",
            fields("token", token),
            null,
            true),
        RevokeResult.class,
        false);
  }

  /** Every user. */
  public AdminUserList listUsers() {
    return await(listUsersAsync());
  }

  /** See {@link #listUsers}. */
  public CompletableFuture<AdminUserList> listUsersAsync() {
    return as(
        "list-users",
        transport.call("list-users", "GET", "/v1/admin/users", null, null, true),
        AdminUserList.class,
        false);
  }

  /** What deleting a user would remove, without removing it. */
  public UserDeletionPreview previewDeleteUser(String id) {
    return await(previewDeleteUserAsync(id));
  }

  /** See {@link #previewDeleteUser}. */
  public CompletableFuture<UserDeletionPreview> previewDeleteUserAsync(String id) {
    if (blank(id)) {
      return invalid("preview-delete-user", "userID is required");
    }
    return as(
        "preview-delete-user",
        transport.call(
            "preview-delete-user",
            "DELETE",
            "/v1/admin/users/" + seg(id),
            null,
            Map.of("dryRun", "true"),
            true),
        UserDeletionPreview.class,
        false);
  }

  /** Deletes a user with their tokens, entries and owned projects. */
  public UserDeletion deleteUser(String id) {
    return await(deleteUserAsync(id));
  }

  /** See {@link #deleteUser}. */
  public CompletableFuture<UserDeletion> deleteUserAsync(String id) {
    if (blank(id)) {
      return invalid("delete-user", "userID is required");
    }
    return as(
        "delete-user",
        transport.call("delete-user", "DELETE", "/v1/admin/users/" + seg(id), null, null, true),
        UserDeletion.class,
        false);
  }

  /** Sets a user's quota overrides. null clears that override (it is sent as JSON null). */
  public QuotaResult setUserQuota(String id, Integer maxEntries, Integer writesPerMinute) {
    return await(setUserQuotaAsync(id, maxEntries, writesPerMinute));
  }

  /** See {@link #setUserQuota}. */
  public CompletableFuture<QuotaResult> setUserQuotaAsync(
      String id, Integer maxEntries, Integer writesPerMinute) {
    if (blank(id)) {
      return invalid("set-user-quota", "userID is required");
    }
    Map<String, Object> body = new HashMap<>();
    body.put("maxEntries", maxEntries);
    body.put("writesPerMinute", writesPerMinute);
    return as(
        "set-user-quota",
        transport.call(
            "set-user-quota", "PUT", "/v1/admin/users/" + seg(id) + "/quota", body, null, true),
        QuotaResult.class,
        false);
  }
}
