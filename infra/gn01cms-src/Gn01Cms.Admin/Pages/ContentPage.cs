using Gn01Cms.Components;
using Gn01Cms.Core;
using Gn01Cms.Data.Entities;
using System.Text.Json;

namespace Gn01Cms.Admin.Pages;

/// <summary>
/// Content list page
/// </summary>
public class ContentListPage
{
    private readonly AdminLayout _layout;
    private readonly AdminTemplate _template;

    public ContentListPage(AdminLayout layout, AdminTemplate template)
    {
        _layout = layout;
        _template = template;
    }

    public async Task<string> RenderAsync(IEnumerable<ContentItem> items, IEnumerable<ContentType> types, int? filterTypeId = null, 
        int page = 1, int pageSize = 20, int totalCount = 0, string? sort = null, bool descending = true)
    {
        var typeList = types.ToList();
        var selectedType = filterTypeId.HasValue ? typeList.FirstOrDefault(t => t.Id == filterTypeId) : null;
        var pageTitle = selectedType != null ? $"Content: {selectedType.Name}" : "All Content";

        // Build base URL for pagination/sorting
        var baseUrl = filterTypeId.HasValue ? $"/admin/content?type={filterTypeId}" : "/admin/content?";
        if (!string.IsNullOrEmpty(sort))
        {
            baseUrl += $"&sort={sort}&order={(descending ? "desc" : "asc")}";
        }

        var content = new Div().Children(
            // Header with filters and action
            new Div().Class("admin-flex admin-flex-between admin-mb-4").Children(
                new Div().Class("admin-flex admin-gap-4 admin-flex-center").Children(
                    new H2().Attr("style", "margin: 0;").Text(pageTitle),
                    TypeFilter(typeList, filterTypeId)
                ),
                selectedType != null 
                    ? new A()
                        .Class("admin-btn admin-btn-primary")
                        .Attr("href", $"/admin/content/new?type={selectedType.Id}")
                        .Text("+ New " + selectedType.Name)
                    : new Span()
            ),

            // Content table with HTMX container
            _template.Card(
                new Div()
                    .Attr("id", "content-table")
                    .Children(
                        ContentTable(items, typeList, filterTypeId, sort, descending),
                        HtmxPagination(page, pageSize, totalCount, filterTypeId, sort, descending)
                    ),
                null
            )
        );

        return await _layout.PageAsync(pageTitle, content);
    }

    /// <summary>
    /// Render just the table and pagination for HTMX partial updates
    /// </summary>
    public string RenderPartial(IEnumerable<ContentItem> items, IEnumerable<ContentType> types, int? filterTypeId = null, 
        int page = 1, int pageSize = 20, int totalCount = 0, string? sort = null, bool descending = true)
    {
        var typeList = types.ToList();
        
        var container = new Div()
            .Attr("id", "content-table")
            .Children(
                ContentTable(items, typeList, filterTypeId, sort, descending),
                HtmxPagination(page, pageSize, totalCount, filterTypeId, sort, descending)
            );

        return container.Render();
    }

    private HtmlElement TypeFilter(List<ContentType> types, int? selectedTypeId)
    {
        var select = new Select()
            .Class("admin-input")
            .Attr("name", "type")
            .Attr("onchange", "window.location='/admin/content?type='+this.value")
            .Attr("style", "width: auto; min-width: 150px;");

        select.AddChild(new Option().Attr("value", "").Text("All Types"));
        
        foreach (var type in types)
        {
            var option = new Option()
                .Attr("value", type.Id.ToString())
                .Text(type.Name);
            
            if (selectedTypeId == type.Id)
                option.Attr("selected", "selected");
            
            select.AddChild(option);
        }

        return select;
    }

    private HtmlElement ContentTable(IEnumerable<ContentItem> items, List<ContentType> types, int? filterTypeId, string? currentSort, bool descending)
    {
        var itemList = items.ToList();
        
        if (!itemList.Any())
        {
            return new Div().Class("admin-text-muted admin-p-4").Text("No content found. Create some content to get started.");
        }

        var baseUrl = filterTypeId.HasValue ? $"/admin/content?type={filterTypeId}" : "/admin/content?";
        
        var columns = new[]
        {
            new SortableColumn("Title", "title"),
            new SortableColumn("Type", "type"),
            new SortableColumn("Status", "status"),
            new SortableColumn("Updated", "updated_at"),
            new SortableColumn("Actions", null)
        };

        var rows = itemList.Select(item =>
        {
            var type = types.FirstOrDefault(t => t.Id == item.TypeId);
            var title = GetTitle(item);
            
            return new HtmlElement[]
            {
                new Div().Children(
                    new Strong().Text(title),
                    new Div().Class("admin-text-muted admin-text-sm").Text(item.Slug)
                ),
                new Span().Class("admin-text-muted").Text(type?.Name ?? "Unknown"),
                _template.Badge(item.Status, item.Status switch
                {
                    "published" => BadgeVariant.Success,
                    "draft" => BadgeVariant.Warning,
                    "archived" => BadgeVariant.Default,
                    _ => BadgeVariant.Default
                }),
                new Span().Class("admin-text-muted").Text(item.UpdatedAt.ToString("MMM dd, yyyy HH:mm")),
                new Div().Class("admin-flex admin-gap-2").Children(
                    new A()
                        .Class("admin-btn admin-btn-ghost admin-btn-sm")
                        .Attr("href", $"/admin/content/{item.Id}")
                        .Text("Edit"),
                    item.Status == "draft"
                        ? new Form()
                            .Attr("method", "post")
                            .Attr("action", $"/admin/content/{item.Id}/publish")
                            .Attr("style", "display: inline;")
                            .Children(
                                _template.Button("Publish", ButtonVariant.Success)
                                    .Submit()
                                    .Class("admin-btn admin-btn-success admin-btn-sm")
                            )
                        : null!
                )
            };
        });

        return _template.SortableTable(columns, rows, baseUrl, currentSort, descending);
    }

    /// <summary>
    /// HTMX-enabled pagination component
    /// </summary>
    private HtmlElement HtmxPagination(int currentPage, int pageSize, int totalCount, int? filterTypeId, string? sort, bool descending)
    {
        var totalPages = (int)Math.Ceiling((double)totalCount / pageSize);
        if (totalPages <= 1) return new Span();

        var nav = new Nav()
            .Class("admin-pagination")
            .Attr("aria-label", "Pagination");

        var ul = new Ul().Class("admin-pagination-list");

        // Build base URL without page parameter
        var baseParams = new List<string>();
        if (filterTypeId.HasValue) baseParams.Add($"type={filterTypeId}");
        if (!string.IsNullOrEmpty(sort)) baseParams.Add($"sort={sort}");
        baseParams.Add($"order={(descending ? "desc" : "asc")}");
        var baseUrl = "/admin/content?" + string.Join("&", baseParams);

        // Previous button
        if (currentPage > 1)
        {
            var prevLink = new A()
                .Class("admin-pagination-link")
                .Attr("href", $"{baseUrl}&page={currentPage - 1}")
                .Attr("hx-get", $"{baseUrl}&page={currentPage - 1}&partial=1")
                .Attr("hx-target", "#content-table")
                .Attr("hx-swap", "outerHTML")
                .Attr("hx-push-url", $"{baseUrl}&page={currentPage - 1}")
                .Attr("hx-indicator", "#loading-indicator")
                .Text("← Prev");
            var prevLi = new Li();
            prevLi.AddChild(prevLink);
            ul.AddChild(prevLi);
        }

        // Page numbers
        var startPage = Math.Max(1, currentPage - 2);
        var endPage = Math.Min(totalPages, startPage + 4);
        if (endPage - startPage < 4)
        {
            startPage = Math.Max(1, endPage - 4);
        }

        if (startPage > 1)
        {
            var firstLink = new A()
                .Class("admin-pagination-link")
                .Attr("href", $"{baseUrl}&page=1")
                .Attr("hx-get", $"{baseUrl}&page=1&partial=1")
                .Attr("hx-target", "#content-table")
                .Attr("hx-swap", "outerHTML")
                .Attr("hx-push-url", $"{baseUrl}&page=1")
                .Text("1");
            var firstLi = new Li();
            firstLi.AddChild(firstLink);
            ul.AddChild(firstLi);
            
            if (startPage > 2)
            {
                var ellipsisLi = new Li();
                ellipsisLi.AddChild(new Span().Class("admin-pagination-ellipsis").Text("..."));
                ul.AddChild(ellipsisLi);
            }
        }

        for (var i = startPage; i <= endPage; i++)
        {
            var pageLink = new A()
                .Class(i == currentPage ? "admin-pagination-link admin-pagination-current" : "admin-pagination-link")
                .Attr("href", $"{baseUrl}&page={i}");
            
            if (i != currentPage)
            {
                pageLink
                    .Attr("hx-get", $"{baseUrl}&page={i}&partial=1")
                    .Attr("hx-target", "#content-table")
                    .Attr("hx-swap", "outerHTML")
                    .Attr("hx-push-url", $"{baseUrl}&page={i}")
                    .Attr("hx-indicator", "#loading-indicator");
            }
            
            pageLink.Text(i.ToString());
            var pageLi = new Li();
            pageLi.AddChild(pageLink);
            ul.AddChild(pageLi);
        }

        if (endPage < totalPages)
        {
            if (endPage < totalPages - 1)
            {
                var ellipsisLi = new Li();
                ellipsisLi.AddChild(new Span().Class("admin-pagination-ellipsis").Text("..."));
                ul.AddChild(ellipsisLi);
            }
            var lastLink = new A()
                .Class("admin-pagination-link")
                .Attr("href", $"{baseUrl}&page={totalPages}")
                .Attr("hx-get", $"{baseUrl}&page={totalPages}&partial=1")
                .Attr("hx-target", "#content-table")
                .Attr("hx-swap", "outerHTML")
                .Attr("hx-push-url", $"{baseUrl}&page={totalPages}")
                .Text(totalPages.ToString());
            var lastLi = new Li();
            lastLi.AddChild(lastLink);
            ul.AddChild(lastLi);
        }

        // Next button
        if (currentPage < totalPages)
        {
            var nextLink = new A()
                .Class("admin-pagination-link")
                .Attr("href", $"{baseUrl}&page={currentPage + 1}")
                .Attr("hx-get", $"{baseUrl}&page={currentPage + 1}&partial=1")
                .Attr("hx-target", "#content-table")
                .Attr("hx-swap", "outerHTML")
                .Attr("hx-push-url", $"{baseUrl}&page={currentPage + 1}")
                .Attr("hx-indicator", "#loading-indicator")
                .Text("Next →");
            var nextLi = new Li();
            nextLi.AddChild(nextLink);
            ul.AddChild(nextLi);
        }

        nav.AddChild(ul);

        // Loading indicator
        var loadingIndicator = new Div()
            .Attr("id", "loading-indicator")
            .Class("htmx-indicator admin-loading")
            .Attr("style", "display: none; text-align: center; padding: 10px;")
            .Text("Loading...");

        // Info text
        var startItem = (currentPage - 1) * pageSize + 1;
        var endItem = Math.Min(currentPage * pageSize, totalCount);
        var info = new Div()
            .Class("admin-pagination-info admin-text-muted admin-text-sm admin-mt-2")
            .Text($"Showing {startItem}-{endItem} of {totalCount} items");

        return new Div().Class("admin-pagination-container admin-mt-4").Children(loadingIndicator, nav, info);
    }

    private static string GetTitle(ContentItem item)
    {
        try
        {
            using var doc = JsonDocument.Parse(item.Data);
            if (doc.RootElement.TryGetProperty("title", out var title))
                return title.GetString() ?? item.Slug;
            if (doc.RootElement.TryGetProperty("name", out var name))
                return name.GetString() ?? item.Slug;
        }
        catch { }
        return item.Slug;
    }
}

/// <summary>
/// Content edit page
/// </summary>
public class ContentEditPage
{
    private readonly AdminLayout _layout;
    private readonly AdminTemplate _template;

    public ContentEditPage(AdminLayout layout, AdminTemplate template)
    {
        _layout = layout;
        _template = template;
    }

    public async Task<string> RenderAsync(ContentType type, ContentItem? item = null, string? error = null)
    {
        var isNew = item == null || item.Id == 0;
        var title = isNew ? $"New {type.Name}" : $"Edit {type.Name}";

        var schema = ParseSchema(type.Schema);
        var data = item != null ? ParseData(item.Data) : new Dictionary<string, JsonElement>();

        var content = new Div().Children(
            // Back link
            new A()
                .Class("admin-text-muted admin-mb-4")
                .Attr("href", $"/admin/content?type={type.Id}")
                .Attr("style", "display: inline-block;")
                .Text($"← Back to {type.Name}"),

            error != null ? _template.Alert(error, AlertType.Error) : null!,

            new Form()
                .Attr("method", "post")
                .Attr("action", isNew ? $"/admin/content/new?type={type.Id}" : $"/admin/content/{item!.Id}")
                .Attr("enctype", "multipart/form-data")
                .Children(
                    // Main content area
                    new Div().Class("admin-grid admin-grid-3 admin-gap-4").Children(
                        // Content fields (2 columns)
                        new Div().Attr("style", "grid-column: span 2;").Children(
                            _template.Card(
                                new Div().Children(
                                    RenderFields(schema, data).ToArray()
                                ),
                                "Content"
                            )
                        ),

                        // Sidebar (1 column)
                        new Div().Children(
                            _template.Card(
                                new Div().Children(
                                    _template.FormGroup("Slug",
                                        _template.Input("slug", "text", "url-friendly-slug")
                                            .Attr("value", item?.Slug ?? "")
                                            .Attr("required", "required")),
                                    
                                    _template.FormGroup("Status",
                                        StatusSelect(item?.Status ?? "draft")),

                                    new Div().Class("admin-flex admin-gap-2 admin-mt-4").Children(
                                        _template.Button("Save", ButtonVariant.Primary).Submit(),
                                        isNew ? null! : _template.Button("Save & Publish", ButtonVariant.Success)
                                            .Submit()
                                            .Attr("name", "action")
                                            .Attr("value", "publish")
                                    )
                                ),
                                "Settings"
                            ),

                            !isNew ? _template.Card(
                                new Div().Children(
                                    new Div().Class("admin-text-sm admin-text-muted").Children(
                                        new Div().Text($"Created: {item!.CreatedAt:MMM dd, yyyy HH:mm}"),
                                        new Div().Text($"Updated: {item.UpdatedAt:MMM dd, yyyy HH:mm}"),
                                        new Div().Text($"Version: {item.Version}")
                                    )
                                ),
                                "Info"
                            ) : null!
                        )
                    )
                )
        );

        return await _layout.PageAsync(title, content);
    }

    private IEnumerable<HtmlElement> RenderFields(SchemaDefinition schema, Dictionary<string, JsonElement> data)
    {
        foreach (var field in schema.Fields)
        {
            var value = data.TryGetValue(field.Name, out var v) ? GetStringValue(v) : "";
            
            HtmlElement input = field.Type switch
            {
                "text" => _template.Input($"field_{field.Name}", "text", field.Label)
                    .Attr("value", value),
                
                "textarea" or "richtext" => new Textarea()
                    .Class("admin-input")
                    .Attr("name", $"field_{field.Name}")
                    .Attr("rows", field.Type == "richtext" ? "15" : "5")
                    .Attr("placeholder", field.Label)
                    .Text(value),
                
                "number" => _template.Input($"field_{field.Name}", "number", field.Label)
                    .Attr("value", value),
                
                "date" => _template.Input($"field_{field.Name}", "date", field.Label)
                    .Attr("value", value),
                
                "datetime" => _template.Input($"field_{field.Name}", "datetime-local", field.Label)
                    .Attr("value", value),
                
                "checkbox" => new Div().Class("admin-flex admin-gap-2 admin-flex-center").Children(
                    new Input()
                        .Attr("type", "checkbox")
                        .Attr("name", $"field_{field.Name}")
                        .Attr("value", "true")
                        .Attr(value == "true" ? "checked" : "", "checked"),
                    new Span().Text(field.Label)
                ),
                
                "select" => RenderSelect(field, value),
                
                "image" or "file" => new Div().Children(
                    _template.Input($"field_{field.Name}", "file"),
                    !string.IsNullOrEmpty(value) 
                        ? new Div().Class("admin-text-sm admin-text-muted admin-mt-1").Text($"Current: {value}")
                        : null!
                ),
                
                _ => _template.Input($"field_{field.Name}", "text", field.Label)
                    .Attr("value", value)
            };

            if (field.Required && field.Type != "checkbox")
            {
                if (input is Input inp)
                    inp.Attr("required", "required");
                else if (input is Textarea ta)
                    ta.Attr("required", "required");
            }

            yield return _template.FormGroup(field.Label, input);
        }
    }

    private HtmlElement RenderSelect(FieldDefinition field, string value)
    {
        var select = new Select()
            .Class("admin-input")
            .Attr("name", $"field_{field.Name}");

        select.AddChild(new Option().Attr("value", "").Text($"Select {field.Label}..."));
        
        foreach (var opt in field.Options ?? Array.Empty<string>())
        {
            var option = new Option().Attr("value", opt).Text(opt);
            if (opt == value)
                option.Attr("selected", "selected");
            select.AddChild(option);
        }

        return select;
    }

    private HtmlElement StatusSelect(string currentStatus)
    {
        var select = new Select()
            .Class("admin-input")
            .Attr("name", "status");

        var statuses = new[] { ("draft", "Draft"), ("published", "Published"), ("archived", "Archived") };
        
        foreach (var (val, label) in statuses)
        {
            var option = new Option().Attr("value", val).Text(label);
            if (val == currentStatus)
                option.Attr("selected", "selected");
            select.AddChild(option);
        }

        return select;
    }

    private static SchemaDefinition ParseSchema(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<SchemaDefinition>(json, new JsonSerializerOptions 
            { 
                PropertyNameCaseInsensitive = true 
            }) ?? new SchemaDefinition();
        }
        catch
        {
            return new SchemaDefinition();
        }
    }

    private static Dictionary<string, JsonElement> ParseData(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var result = new Dictionary<string, JsonElement>();
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                result[prop.Name] = prop.Value.Clone();
            }
            return result;
        }
        catch
        {
            return new Dictionary<string, JsonElement>();
        }
    }

    private static string GetStringValue(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString() ?? "",
            JsonValueKind.Number => element.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => element.GetRawText()
        };
    }
}

/// <summary>
/// Schema definition for content types
/// </summary>
public class SchemaDefinition
{
    public List<FieldDefinition> Fields { get; set; } = new();
}

/// <summary>
/// Field definition in schema
/// </summary>
public class FieldDefinition
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "text";
    public string Label { get; set; } = "";
    public bool Required { get; set; }
    public string[]? Options { get; set; }
}
