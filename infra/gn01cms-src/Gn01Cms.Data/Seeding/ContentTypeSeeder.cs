using System.Data;
using System.Text.Json;
using Dapper;
using Serilog;

namespace Gn01Cms.Data.Seeding;

public static class ContentTypeSeeder
{
    public static async Task SeedAsync(IDbConnection conn, int tenantId)
    {
        var existingTypes = await conn.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM content_types WHERE tenant_id = @TenantId", new { TenantId = tenantId });
        
        if (existingTypes > 0) return;

        var now = DateTime.UtcNow;

        // Page content type
        var pageSchema = JsonSerializer.Serialize(new
        {
            fields = new[]
            {
                new { name = "title", type = "text", label = "Title", required = true },
                new { name = "content", type = "richtext", label = "Content", required = true },
                new { name = "excerpt", type = "textarea", label = "Excerpt", required = false },
                new { name = "featured_image", type = "file", label = "Featured Image", required = false },
                new { name = "seo_title", type = "text", label = "SEO Title", required = false },
                new { name = "seo_description", type = "textarea", label = "SEO Description", required = false }
            }
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_types (tenant_id, name, slug, description, schema, settings, created_at, updated_at)
              VALUES (@TenantId, 'Page', 'page', 'Static pages for your website', @Schema, '{}', @Now, @Now)",
            new { TenantId = tenantId, Schema = pageSchema, Now = now });

        // Blog Post content type
        var postSchema = JsonSerializer.Serialize(new
        {
            fields = new object[]
            {
                new { name = "title", type = "text", label = "Title", required = true },
                new { name = "content", type = "richtext", label = "Content", required = true },
                new { name = "excerpt", type = "textarea", label = "Excerpt", required = false },
                new { name = "featured_image", type = "file", label = "Featured Image", required = false },
                new { name = "category", type = "select", label = "Category", required = false, options = new[] { "General", "News", "Tutorial", "Review" } },
                new { name = "tags", type = "text", label = "Tags (comma-separated)", required = false },
                new { name = "allow_comments", type = "checkbox", label = "Allow Comments", required = false }
            }
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_types (tenant_id, name, slug, description, schema, settings, created_at, updated_at)
              VALUES (@TenantId, 'Blog Post', 'post', 'Blog posts and articles', @Schema, '{}', @Now, @Now)",
            new { TenantId = tenantId, Schema = postSchema, Now = now });

        // Product content type
        var productSchema = JsonSerializer.Serialize(new
        {
            fields = new[]
            {
                new { name = "name", type = "text", label = "Product Name", required = true },
                new { name = "description", type = "richtext", label = "Description", required = true },
                new { name = "short_description", type = "textarea", label = "Short Description", required = false },
                new { name = "price", type = "number", label = "Price", required = true },
                new { name = "sale_price", type = "number", label = "Sale Price", required = false },
                new { name = "sku", type = "text", label = "SKU", required = false },
                new { name = "stock", type = "number", label = "Stock Quantity", required = false },
                new { name = "image", type = "file", label = "Product Image", required = false },
                new { name = "gallery", type = "text", label = "Gallery (image IDs)", required = false }
            }
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_types (tenant_id, name, slug, description, schema, settings, created_at, updated_at)
              VALUES (@TenantId, 'Product', 'product', 'E-commerce products', @Schema, '{}', @Now, @Now)",
            new { TenantId = tenantId, Schema = productSchema, Now = now });

        // Event content type
        var eventSchema = JsonSerializer.Serialize(new
        {
            fields = new[]
            {
                new { name = "title", type = "text", label = "Event Title", required = true },
                new { name = "description", type = "richtext", label = "Description", required = true },
                new { name = "start_date", type = "datetime", label = "Start Date/Time", required = true },
                new { name = "end_date", type = "datetime", label = "End Date/Time", required = false },
                new { name = "location", type = "text", label = "Location", required = false },
                new { name = "venue", type = "textarea", label = "Venue Details", required = false },
                new { name = "registration_url", type = "url", label = "Registration URL", required = false },
                new { name = "image", type = "file", label = "Event Image", required = false }
            }
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_types (tenant_id, name, slug, description, schema, settings, created_at, updated_at)
              VALUES (@TenantId, 'Event', 'event', 'Events and happenings', @Schema, '{}', @Now, @Now)",
            new { TenantId = tenantId, Schema = eventSchema, Now = now });

        // FAQ content type
        var faqSchema = JsonSerializer.Serialize(new
        {
            fields = new object[]
            {
                new { name = "question", type = "text", label = "Question", required = true },
                new { name = "answer", type = "richtext", label = "Answer", required = true },
                new { name = "category", type = "select", label = "Category", required = false, options = new[] { "General", "Billing", "Technical", "Account" } },
                new { name = "order", type = "number", label = "Display Order", required = false }
            }
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_types (tenant_id, name, slug, description, schema, settings, created_at, updated_at)
              VALUES (@TenantId, 'FAQ', 'faq', 'Frequently asked questions', @Schema, '{}', @Now, @Now)",
            new { TenantId = tenantId, Schema = faqSchema, Now = now });

        // Team Member content type
        var teamSchema = JsonSerializer.Serialize(new
        {
            fields = new[]
            {
                new { name = "name", type = "text", label = "Full Name", required = true },
                new { name = "position", type = "text", label = "Position/Title", required = true },
                new { name = "bio", type = "richtext", label = "Biography", required = false },
                new { name = "photo", type = "file", label = "Photo", required = false },
                new { name = "email", type = "email", label = "Email", required = false },
                new { name = "phone", type = "text", label = "Phone", required = false },
                new { name = "linkedin", type = "url", label = "LinkedIn URL", required = false },
                new { name = "twitter", type = "url", label = "Twitter URL", required = false },
                new { name = "order", type = "number", label = "Display Order", required = false }
            }
        });

        await conn.ExecuteAsync(
            @"INSERT INTO content_types (tenant_id, name, slug, description, schema, settings, created_at, updated_at)
              VALUES (@TenantId, 'Team Member', 'team', 'Team and staff members', @Schema, '{}', @Now, @Now)",
            new { TenantId = tenantId, Schema = teamSchema, Now = now });

        Log.Information("Seeded content types: Page, Blog Post, Product, Event, FAQ, Team Member");
    }
}
