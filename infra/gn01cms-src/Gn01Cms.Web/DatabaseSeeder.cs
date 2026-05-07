using Dapper;
using Gn01Cms.Data;
using Gn01Cms.Data.Entities;
using Gn01Cms.Data.Repositories;
using Gn01Cms.Data.Seeding;
using Gn01Cms.Auth;
using Serilog;

namespace Gn01Cms.Web;

public static class DatabaseSeeder
{
    public static async Task SeedDefaultDataAsync(IServiceProvider services)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IDbConnectionFactory>();
        var tenantRepo = scope.ServiceProvider.GetRequiredService<ITenantRepository>();
        var userRepo = scope.ServiceProvider.GetRequiredService<IUserRepository>();
        var passwordHasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>() as TenantContext;

        // Check if default tenant exists
        var tenant = await tenantRepo.GetBySlugAsync("default");
        if (tenant == null)
        {
            // Create default tenant
            tenant = new Tenant
            {
                Name = "Default",
                Slug = "default",
                Settings = "{}",
                IsActive = true
            };
            tenant.Id = await tenantRepo.InsertAsync(tenant);
            Log.Information("Created default tenant");
        }

        // Set tenant context
        if (tenantContext != null)
        {
            tenantContext.TenantId = tenant.Id;
            tenantContext.TenantSlug = tenant.Slug;
        }

        using var conn = db.CreateConnection();
        conn.Open();

        // Seed permissions
        await PermissionSeeder.SeedAsync(conn);

        // Seed roles
        await RoleSeeder.SeedAsync(conn, tenant.Id);

        // Seed admin user
        var adminUser = await userRepo.GetByUsernameAsync("admin");
        if (adminUser == null)
        {
            var hash = passwordHasher.HashPassword("admin123");
            adminUser = new User
            {
                TenantId = tenant.Id,
                Username = "admin",
                Email = "admin@localhost",
                PasswordHash = hash,
                DisplayName = "Administrator",
                Status = "active",
                Metadata = "{\"roles\":[\"admin\"]}"
            };
            await userRepo.InsertAsync(adminUser);
            // Retrieve the user to get the ID
            adminUser = await userRepo.GetByUsernameAsync("admin");
            Log.Information("Created admin user (username: admin, password: admin123)");

            // Assign admin role
            var adminRoleId = await conn.ExecuteScalarAsync<int?>(
                "SELECT id FROM roles WHERE tenant_id = @TenantId AND name = 'Administrator'",
                new { TenantId = tenant.Id });
            if (adminRoleId.HasValue && adminUser != null)
            {
                await conn.ExecuteAsync(
                    "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (@UserId, @RoleId)",
                    new { UserId = adminUser.Id, RoleId = adminRoleId.Value });
            }
        }

        // Seed content types
        await ContentTypeSeeder.SeedAsync(conn, tenant.Id);

        // Seed sample content
        await SampleContentSeeder.SeedAsync(conn, tenant.Id, adminUser?.Id ?? 1);

        // Seed default settings
        await SettingsSeeder.SeedAsync(conn, tenant.Id);
    }
}
