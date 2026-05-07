using System.Data;
using System.Text.Json;
using Dapper;
using Serilog;

namespace Gn01Cms.Data.Seeding;

public static class SampleContentSeeder
{
    public static async Task SeedAsync(IDbConnection conn, int tenantId, int authorId)
    {
        var existingContent = await conn.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM content_items WHERE tenant_id = @TenantId", new { TenantId = tenantId });
        
        if (existingContent > 0) return;

        var now = DateTime.UtcNow;

        // Get content type IDs
        var pageTypeId = await conn.ExecuteScalarAsync<int?>(
            "SELECT id FROM content_types WHERE tenant_id = @TenantId AND slug = 'page'", new { TenantId = tenantId });
        var postTypeId = await conn.ExecuteScalarAsync<int?>(
            "SELECT id FROM content_types WHERE tenant_id = @TenantId AND slug = 'post'", new { TenantId = tenantId });
        var faqTypeId = await conn.ExecuteScalarAsync<int?>(
            "SELECT id FROM content_types WHERE tenant_id = @TenantId AND slug = 'faq'", new { TenantId = tenantId });

        if (pageTypeId == null || postTypeId == null || faqTypeId == null)
        {
            Log.Warning("Content types not found - skipping sample content seeding");
            return;
        }

        // Sample Home page
        var homeData = JsonSerializer.Serialize(new
        {
            title = "Welcome to Gn01 CMS",
            content = "<h2>A Modern Code-First CMS</h2><p>Gn01 CMS is a flexible, code-first content management system built with .NET 10 and HTMX. It offers a powerful admin interface, flexible content schemas, and a plugin architecture for extensibility.</p><h3>Key Features</h3><ul><li>Code-first HTML rendering</li><li>HTMX for dynamic updates</li><li>Flexible content types</li><li>Multi-tenancy support</li><li>Plugin architecture</li></ul>",
            excerpt = "Welcome to Gn01 CMS - a modern, flexible content management system.",
            seo_title = "Gn01 CMS - Modern Content Management",
            seo_description = "A flexible, code-first content management system built with .NET 10 and HTMX."
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_items (tenant_id, type_id, slug, status, data, created_by, version, created_at, updated_at, published_at)
              VALUES (@TenantId, @TypeId, 'home', 'published', @Data, @CreatedBy, 1, @Now, @Now, @Now)",
            new { TenantId = tenantId, TypeId = pageTypeId, Data = homeData, CreatedBy = authorId, Now = now });

        // Sample About page
        var aboutData = JsonSerializer.Serialize(new
        {
            title = "About Us",
            content = "<p>Gn01 CMS is designed to be flexible, powerful, and developer-friendly. Built from the ground up with modern technologies, it provides a solid foundation for any content-driven website.</p><h3>Our Mission</h3><p>To provide developers with a CMS that doesn't get in the way - one that's easy to extend, customize, and integrate with existing systems.</p>",
            excerpt = "Learn more about Gn01 CMS and our mission.",
            seo_title = "About - Gn01 CMS",
            seo_description = "Learn about Gn01 CMS and our mission to provide a flexible, developer-friendly content management system."
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_items (tenant_id, type_id, slug, status, data, created_by, version, created_at, updated_at, published_at)
              VALUES (@TenantId, @TypeId, 'about', 'published', @Data, @CreatedBy, 1, @Now, @Now, @Now)",
            new { TenantId = tenantId, TypeId = pageTypeId, Data = aboutData, CreatedBy = authorId, Now = now });

        // Sample Blog Post
        var post1Data = JsonSerializer.Serialize(new
        {
            title = "Getting Started with Gn01 CMS",
            content = "<p>Welcome to Gn01 CMS! This guide will help you get started with creating and managing content.</p><h2>Creating Content</h2><p>Navigate to the Content section in the admin panel to create new pages, posts, and other content types.</p><h2>Managing Content Types</h2><p>Content types define the structure of your content. Each type has a schema that specifies the fields available for that content.</p><h2>Next Steps</h2><p>Explore the admin panel, create some content, and customize your site!</p>",
            excerpt = "A quick guide to getting started with Gn01 CMS.",
            category = "Tutorial",
            tags = "getting-started, tutorial, guide",
            allow_comments = "true"
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_items (tenant_id, type_id, slug, status, data, created_by, version, created_at, updated_at, published_at)
              VALUES (@TenantId, @TypeId, 'getting-started', 'published', @Data, @CreatedBy, 1, @Now, @Now, @Now)",
            new { TenantId = tenantId, TypeId = postTypeId, Data = post1Data, CreatedBy = authorId, Now = now });

        // Sample FAQs
        var faq1Data = JsonSerializer.Serialize(new { question = "What is Gn01 CMS?", answer = "<p>Gn01 CMS is a code-first content management system built with .NET 10 and HTMX. It provides a flexible, developer-friendly platform for building content-driven websites.</p>", category = "General", order = "1" });
        var faq2Data = JsonSerializer.Serialize(new { question = "How do I create content?", answer = "<p>Navigate to the Content section in the admin panel, select a content type, and click 'New'. Fill in the fields and save your content.</p>", category = "General", order = "2" });
        var faq3Data = JsonSerializer.Serialize(new { question = "Can I create custom content types?", answer = "<p>Yes! Go to Content Types in the admin panel to create new content types with custom fields and schemas.</p>", category = "Technical", order = "3" });

        await conn.ExecuteAsync(
            @"INSERT INTO content_items (tenant_id, type_id, slug, status, data, created_by, version, created_at, updated_at, published_at)
              VALUES (@TenantId, @TypeId, 'what-is-gn01-cms', 'published', @Data, @CreatedBy, 1, @Now, @Now, @Now)",
            new { TenantId = tenantId, TypeId = faqTypeId, Data = faq1Data, CreatedBy = authorId, Now = now });

        await conn.ExecuteAsync(
            @"INSERT INTO content_items (tenant_id, type_id, slug, status, data, created_by, version, created_at, updated_at, published_at)
              VALUES (@TenantId, @TypeId, 'how-to-create-content', 'published', @Data, @CreatedBy, 1, @Now, @Now, @Now)",
            new { TenantId = tenantId, TypeId = faqTypeId, Data = faq2Data, CreatedBy = authorId, Now = now });

        await conn.ExecuteAsync(
            @"INSERT INTO content_items (tenant_id, type_id, slug, status, data, created_by, version, created_at, updated_at, published_at)
              VALUES (@TenantId, @TypeId, 'custom-content-types', 'published', @Data, @CreatedBy, 1, @Now, @Now, @Now)",
            new { TenantId = tenantId, TypeId = faqTypeId, Data = faq3Data, CreatedBy = authorId, Now = now });

        Log.Information("Seeded sample content: 2 pages, 1 blog post, 3 FAQs");
    }
}
