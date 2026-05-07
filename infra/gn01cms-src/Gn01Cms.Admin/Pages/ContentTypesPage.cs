using Gn01Cms.Components;
using Gn01Cms.Core;
using Gn01Cms.Data.Entities;

namespace Gn01Cms.Admin.Pages;

/// <summary>
/// Content Types list page
/// </summary>
public class ContentTypesPage
{
    private readonly AdminLayout _layout;
    private readonly AdminTemplate _template;

    public ContentTypesPage(AdminLayout layout, AdminTemplate template)
    {
        _layout = layout;
        _template = template;
    }

    public async Task<string> RenderAsync(IEnumerable<ContentType> types)
    {
        var content = new Div().Children(
            // Header with action button
            new Div().Class("admin-flex admin-flex-between admin-mb-4").Children(
                new H2().Text("Content Types"),
                new A()
                    .Class("admin-btn admin-btn-primary")
                    .Attr("href", "/admin/types/new")
                    .Text("+ New Type")
            ),

            // Types table
            _template.Card(
                TypesTable(types),
                null
            )
        );

        return await _layout.PageAsync("Content Types", content);
    }

    private HtmlElement TypesTable(IEnumerable<ContentType> types)
    {
        var typeList = types.ToList();
        
        if (!typeList.Any())
        {
            return new Div().Class("admin-text-muted admin-p-4").Text("No content types defined yet. Create one to get started.");
        }

        var rows = typeList.Select(t => new HtmlElement[]
        {
            new Div().Children(
                new Strong().Text(t.Name),
                new Div().Class("admin-text-muted admin-text-sm").Text(t.Slug)
            ),
            new Span().Text(t.Description ?? "-"),
            new Span().Class("admin-text-muted").Text(t.UpdatedAt.ToString("MMM dd, yyyy")),
            new Div().Class("admin-flex admin-gap-2").Children(
                new A()
                    .Class("admin-btn admin-btn-ghost admin-btn-sm")
                    .Attr("href", $"/admin/types/{t.Id}")
                    .Text("Edit"),
                new A()
                    .Class("admin-btn admin-btn-ghost admin-btn-sm")
                    .Attr("href", $"/admin/content?type={t.Id}")
                    .Text("View Content")
            )
        });

        return _template.Table(
            new[] { "Name", "Description", "Updated", "Actions" },
            rows
        );
    }
}

/// <summary>
/// Content Type edit page
/// </summary>
public class ContentTypeEditPage
{
    private readonly AdminLayout _layout;
    private readonly AdminTemplate _template;

    public ContentTypeEditPage(AdminLayout layout, AdminTemplate template)
    {
        _layout = layout;
        _template = template;
    }

    public async Task<string> RenderAsync(ContentType? type = null, string? error = null)
    {
        var isNew = type == null || type.Id == 0;
        var title = isNew ? "New Content Type" : $"Edit: {type!.Name}";

        var content = new Div().Children(
            // Back link
            new A()
                .Class("admin-text-muted admin-mb-4")
                .Attr("href", "/admin/types")
                .Attr("style", "display: inline-block;")
                .Text("← Back to Content Types"),

            error != null ? _template.Alert(error, AlertType.Error) : null!,

            _template.Card(
                new Form()
                    .Attr("method", "post")
                    .Attr("action", isNew ? "/admin/types/new" : $"/admin/types/{type!.Id}")
                    .Children(
                        _template.FormGroup("Name", 
                            _template.Input("name", "text", "e.g. Blog Post")
                                .Attr("value", type?.Name ?? "")
                                .Attr("required", "required")),
                        
                        _template.FormGroup("Slug",
                            _template.Input("slug", "text", "e.g. blog-post")
                                .Attr("value", type?.Slug ?? "")
                                .Attr("required", "required")),
                        
                        _template.FormGroup("Description",
                            new Textarea()
                                .Class("admin-input")
                                .Attr("name", "description")
                                .Attr("rows", "3")
                                .Attr("placeholder", "Brief description of this content type")
                                .Text(type?.Description ?? "")),
                        
                        _template.FormGroup("Icon",
                            _template.Input("icon", "text", "e.g. file-text")
                                .Attr("value", type?.Icon ?? "")),

                        new Div().Class("admin-mb-4").Children(
                            new Label().Class("admin-label").Text("Schema (JSON)"),
                            new Textarea()
                                .Class("admin-input")
                                .Attr("name", "schema")
                                .Attr("rows", "15")
                                .Attr("style", "font-family: monospace;")
                                .Text(type?.Schema ?? GetDefaultSchema())
                        ),

                        new Div().Class("admin-flex admin-gap-2").Children(
                            _template.Button("Save", ButtonVariant.Primary).Submit(),
                            new A()
                                .Class("admin-btn admin-btn-secondary")
                                .Attr("href", "/admin/types")
                                .Text("Cancel")
                        )
                    ),
                title
            )
        );

        return await _layout.PageAsync(title, content);
    }

    private static string GetDefaultSchema()
    {
        return @"{
  ""fields"": [
    {
      ""name"": ""title"",
      ""type"": ""text"",
      ""label"": ""Title"",
      ""required"": true
    },
    {
      ""name"": ""content"",
      ""type"": ""richtext"",
      ""label"": ""Content""
    }
  ]
}";
    }
}
