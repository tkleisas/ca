using Gn01Cms.Admin.Pages;
using Gn01Cms.Auth;
using Gn01Cms.Cms;
using Gn01Cms.Core;
using Gn01Cms.Components;
using Gn01Cms.Data.Entities;
using Gn01Cms.Frontend;
using Gn01Cms.Templates;
using System.Text.Json;

namespace Gn01Cms.Web.Routes;

public static class PublicRoutes
{
    public static WebApplication MapPublicRoutes(this WebApplication app)
    {
        // Homepage - uses front_page_content_id setting or shows default
        app.MapGet("/", async (
            ISettingsService settingsService, 
            IContentService contentService,
            IContentTypeService typeService,
            INavigationService navigationService,
            ICurrentUser currentUser) =>
        {
            var settings = await settingsService.GetAllAsync();
            var siteName = settings.GetValueOrDefault("site_name", "Gn01 CMS");
            var siteDescription = settings.GetValueOrDefault("site_description", "A modern, flexible content management system");
            var frontPageContentId = settings.GetValueOrDefault("front_page_content_id", "");

            // Create frontend layout
            var frontendSettings = new FrontendSettings
            {
                SiteName = siteName
            };
            var mainMenu = await navigationService.GetMenuAsync("main");
            var layout = new FrontendLayout(frontendSettings, mainMenu, null, currentUser.IsAuthenticated, currentUser.User?.Username);

            // If front page content is set, render it
            if (!string.IsNullOrEmpty(frontPageContentId) && int.TryParse(frontPageContentId, out var contentId))
            {
                var content = await contentService.GetAsync(contentId);
                if (content != null && content.Status == "published")
                {
                    var html = RenderSingleContent(content, layout, siteName);
                    return Results.Content(html, "text/html");
                }
            }

            // Default homepage
            var defaultHtml = RenderDefaultHomepage(layout, siteName, siteDescription);
            return Results.Content(defaultHtml, "text/html");
        });

        // Content list by type slug with pagination and sorting
        app.MapGet("/{typeSlug}", async (
            string typeSlug,
            HttpContext ctx,
            ISettingsService settingsService,
            IContentService contentService,
            IContentTypeService typeService,
            INavigationService navigationService,
            ICurrentUser currentUser) =>
        {
            // Skip admin and API routes
            if (typeSlug == "admin" || typeSlug == "api" || typeSlug == "files")
                return Results.NotFound();

            var type = await typeService.GetBySlugAsync(typeSlug);
            if (type == null)
                return Results.NotFound();

            var settings = await settingsService.GetAllAsync();
            var siteName = settings.GetValueOrDefault("site_name", "Gn01 CMS");
            var postsPerPage = int.TryParse(settings.GetValueOrDefault("posts_per_page", "10"), out var ppp) ? ppp : 10;
            var defaultSort = settings.GetValueOrDefault("default_content_sort", "created_at_desc");

            // Parse pagination and sorting from query
            var page = int.TryParse(ctx.Request.Query["page"], out var p) ? Math.Max(1, p) : 1;
            var sort = ctx.Request.Query["sort"].FirstOrDefault() ?? GetSortColumn(defaultSort);
            var order = ctx.Request.Query["order"].FirstOrDefault() ?? GetSortOrder(defaultSort);
            var descending = order.Equals("desc", StringComparison.OrdinalIgnoreCase);

            var query = new ContentQuery
            {
                Status = "published",
                Limit = postsPerPage,
                Offset = (page - 1) * postsPerPage,
                OrderBy = sort,
                Descending = descending
            };

            var items = await contentService.ListAsync(type.Id, query);
            var totalCount = await contentService.CountAsync(type.Id);

            var frontendSettings = new FrontendSettings
            {
                SiteName = siteName
            };
            var mainMenu = await navigationService.GetMenuAsync("main");
            var layout = new FrontendLayout(frontendSettings, mainMenu, null, currentUser.IsAuthenticated, currentUser.User?.Username);

            var html = RenderContentList(type.Name, items, page, postsPerPage, totalCount, sort, descending, $"/{typeSlug}", layout, siteName);
            return Results.Content(html, "text/html");
        });

        // Single content by type slug and content slug
        app.MapGet("/{typeSlug}/{slug}", async (
            string typeSlug,
            string slug,
            ISettingsService settingsService,
            IContentService contentService,
            IContentTypeService typeService,
            INavigationService navigationService,
            ICurrentUser currentUser) =>
        {
            if (typeSlug == "admin" || typeSlug == "api" || typeSlug == "files")
                return Results.NotFound();

            var type = await typeService.GetBySlugAsync(typeSlug);
            if (type == null)
                return Results.NotFound();

            var content = await contentService.GetBySlugAsync(slug, type.Id);
            if (content == null || content.Status != "published")
                return Results.NotFound();

            var settings = await settingsService.GetAllAsync();
            var siteName = settings.GetValueOrDefault("site_name", "Gn01 CMS");

            var frontendSettings = new FrontendSettings
            {
                SiteName = siteName
            };
            var mainMenu = await navigationService.GetMenuAsync("main");
            var layout = new FrontendLayout(frontendSettings, mainMenu, null, currentUser.IsAuthenticated, currentUser.User?.Username);

            var html = RenderSingleContent(content, layout, siteName);
            return Results.Content(html, "text/html");
        });

        return app;
    }

    private static string GetSortColumn(string defaultSort)
    {
        return defaultSort switch
        {
            "created_at_desc" or "created_at_asc" => "created_at",
            "updated_at_desc" or "updated_at_asc" => "updated_at",
            "title_asc" or "title_desc" => "title",
            _ => "created_at"
        };
    }

    private static string GetSortOrder(string defaultSort)
    {
        return defaultSort.EndsWith("_asc") ? "asc" : "desc";
    }

    private static string RenderDefaultHomepage(FrontendLayout layout, string siteName, string siteDescription)
    {
        var content = new Div()
            .Class("text-center py-16")
            .Children(
                new H1().Class("text-4xl font-bold text-gray-900 mb-4").Text($"Welcome to {siteName}"),
                new P().Class("text-xl text-gray-600 mb-8").Text(siteDescription),
                new Div().Class("flex justify-center space-x-4").Children(
                    new A()
                        .Href("/admin")
                        .Class("inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors")
                        .Text("Admin Panel"),
                    new A()
                        .Href("/post")
                        .Class("inline-block px-6 py-3 border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors")
                        .Text("View Blog")
                )
            );

        return layout.Page(siteName, content);
    }

    private static string RenderContentList(string typeName, IEnumerable<ContentItem> items, int page, int pageSize, int totalCount, string sort, bool descending, string baseUrl, FrontendLayout layout, string siteName)
    {
        var itemList = items.ToList();
        var totalPages = (int)Math.Ceiling((double)totalCount / pageSize);

        var content = new Div().Children(
            new H1().Class("text-3xl font-bold text-gray-900 mb-6").Text(typeName),
            
            // Sort controls
            new Div().Class("flex justify-between items-center mb-6").Children(
                new Span().Class("text-gray-600").Text($"Showing {itemList.Count} of {totalCount} items"),
                new Div().Class("flex space-x-2").Children(
                    new Label().Class("text-sm text-gray-600 mr-2").Text("Sort by:"),
                    new A()
                        .Href($"{baseUrl}?sort=created_at&order=desc")
                        .Class($"px-3 py-1 text-sm rounded {(sort == "created_at" && descending ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300")}")
                        .Text("Newest"),
                    new A()
                        .Href($"{baseUrl}?sort=created_at&order=asc")
                        .Class($"px-3 py-1 text-sm rounded {(sort == "created_at" && !descending ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300")}")
                        .Text("Oldest"),
                    new A()
                        .Href($"{baseUrl}?sort=updated_at&order=desc")
                        .Class($"px-3 py-1 text-sm rounded {(sort == "updated_at" && descending ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300")}")
                        .Text("Updated"),
                    new A()
                        .Href($"{baseUrl}?sort=title&order=asc")
                        .Class($"px-3 py-1 text-sm rounded {(sort == "title" ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300")}")
                        .Text("A-Z")
                )
            ),
            
            // Content list
            new Div().Class("space-y-6").Children(
                itemList.Select(item => RenderContentCard(item, baseUrl)).ToArray()
            ),
            
            // Pagination
            totalPages > 1 ? RenderPagination(page, totalPages, baseUrl, sort, descending) : null!
        );

        return layout.Page($"{typeName} - {siteName}", content);
    }

    private static HtmlElement RenderContentCard(ContentItem item, string baseUrl)
    {
        var dataDoc = JsonDocument.Parse(item.Data);
        var title = dataDoc.RootElement.TryGetProperty("title", out var titleProp) 
            ? titleProp.GetString() ?? $"Content #{item.Id}" 
            : $"Content #{item.Id}";
        var excerpt = dataDoc.RootElement.TryGetProperty("excerpt", out var excerptProp)
            ? excerptProp.GetString() ?? ""
            : "";
        if (string.IsNullOrEmpty(excerpt))
        {
            // Try to get first 200 chars of content
            if (dataDoc.RootElement.TryGetProperty("content", out var contentProp))
            {
                var fullContent = contentProp.GetString() ?? "";
                excerpt = fullContent.Length > 200 ? fullContent.Substring(0, 200) + "..." : fullContent;
            }
        }

        return new Article()
            .Class("bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition-shadow")
            .Children(
                new H2().Class("text-xl font-semibold text-gray-900 mb-2").Children(
                    new A()
                        .Href($"{baseUrl}/{item.Slug}")
                        .Class("hover:text-blue-600")
                        .Text(title)
                ),
                !string.IsNullOrEmpty(excerpt)
                    ? new P().Class("text-gray-600 mb-4").Text(excerpt)
                    : null!,
                new Div().Class("flex items-center text-sm text-gray-500").Children(
                    new Span().Text(item.CreatedAt.ToString("MMM dd, yyyy")),
                    item.UpdatedAt > item.CreatedAt
                        ? new Span().Class("ml-4").Text($"Updated: {item.UpdatedAt:MMM dd, yyyy}")
                        : null!
                )
            );
    }

    private static HtmlElement RenderPagination(int currentPage, int totalPages, string baseUrl, string sort, bool descending)
    {
        var sortParams = $"&sort={sort}&order={(descending ? "desc" : "asc")}";
        var elements = new List<HtmlElement>();

        // Previous
        if (currentPage > 1)
        {
            elements.Add(new A()
                .Href($"{baseUrl}?page={currentPage - 1}{sortParams}")
                .Class("px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300")
                .Text("← Previous"));
        }

        // Page numbers
        var startPage = Math.Max(1, currentPage - 2);
        var endPage = Math.Min(totalPages, currentPage + 2);

        for (var i = startPage; i <= endPage; i++)
        {
            var isCurrentPage = i == currentPage;
            elements.Add(new A()
                .Href($"{baseUrl}?page={i}{sortParams}")
                .Class($"px-4 py-2 rounded {(isCurrentPage ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300")}")
                .Text(i.ToString()));
        }

        // Next
        if (currentPage < totalPages)
        {
            elements.Add(new A()
                .Href($"{baseUrl}?page={currentPage + 1}{sortParams}")
                .Class("px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300")
                .Text("Next →"));
        }

        return new Div()
            .Class("flex justify-center space-x-2 mt-8")
            .Children(elements.ToArray());
    }

    private static string RenderSingleContent(ContentItem content, FrontendLayout layout, string siteName)
    {
        var dataDoc = JsonDocument.Parse(content.Data);
        var title = dataDoc.RootElement.TryGetProperty("title", out var titleProp) 
            ? titleProp.GetString() ?? $"Content #{content.Id}" 
            : $"Content #{content.Id}";
        var body = dataDoc.RootElement.TryGetProperty("content", out var contentProp)
            ? contentProp.GetString() ?? ""
            : "";

        var contentHtml = new Article()
            .Class("prose prose-lg max-w-none")
            .Children(
                new H1().Class("text-4xl font-bold text-gray-900 mb-4").Text(title),
                new Div().Class("flex items-center text-sm text-gray-500 mb-8").Children(
                    new Span().Text($"Published: {content.PublishedAt?.ToString("MMM dd, yyyy") ?? content.CreatedAt.ToString("MMM dd, yyyy")}"),
                    content.UpdatedAt > content.CreatedAt
                        ? new Span().Class("ml-4").Text($"Updated: {content.UpdatedAt:MMM dd, yyyy}")
                        : null!
                ),
                new Div().Class("content-body").Html(body)
            );

        return layout.Page($"{title} - {siteName}", contentHtml);
    }
}
