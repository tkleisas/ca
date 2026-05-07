using Gn01Cms.Core;
using Gn01Cms.Components;

namespace Gn01Cms.Admin;

/// <summary>
/// Admin template with dark theme
/// </summary>
public class AdminTemplate
{
    private const string PrimaryColor = "#3b82f6";  // Blue
    private const string BgDark = "#0f172a";        // Slate 900
    private const string BgDarker = "#020617";      // Slate 950
    private const string BgCard = "#1e293b";        // Slate 800
    private const string TextLight = "#f1f5f9";     // Slate 100
    private const string TextMuted = "#94a3b8";     // Slate 400
    private const string BorderColor = "#334155";   // Slate 700

    public string Name => "Admin Dark";

    public string WrapPage(HtmlElement content, PageMeta? meta = null)
    {
        var title = meta?.Title ?? "Admin";
        var description = meta?.Description;

        var doc = new HtmlDocument()
            .Lang("en")
            .Head(h => h
                .Title(title)
                .InlineCss(GetCss())
                .Script("https://unpkg.com/htmx.org@2.0.0", defer: true)
                .Script("https://unpkg.com/htmx-ext-sse@2.2.2/sse.js", defer: true)
            )
            .Body(b => b
                .Class("admin-body")
                .Attr("hx-ext", "sse")
                .Children(content)
            );

        return doc.Render();
    }

    public HtmlElement Card(HtmlElement content, string? title = null)
    {
        var card = new Div().Class("admin-card");
        
        if (title != null)
        {
            card.AddChild(new Div().Class("admin-card-header").Children(
                new H3().Class("admin-card-title").Text(title)
            ));
        }

        card.AddChild(new Div().Class("admin-card-body").Children(content));
        return card;
    }

    public Button Button(string text, ButtonVariant variant = ButtonVariant.Primary)
    {
        var className = variant switch
        {
            ButtonVariant.Secondary => "admin-btn admin-btn-secondary",
            ButtonVariant.Danger => "admin-btn admin-btn-danger",
            ButtonVariant.Success => "admin-btn admin-btn-success",
            ButtonVariant.Ghost => "admin-btn admin-btn-ghost",
            _ => "admin-btn admin-btn-primary"
        };
        
        return new Button().Class(className).Text(text);
    }

    public Input Input(string name, string type = "text", string? placeholder = null)
    {
        var input = new Input()
            .Class("admin-input")
            .Attr("type", type)
            .Attr("name", name)
            .Attr("id", name);
        
        if (placeholder != null)
            input.AddAttribute("placeholder", placeholder);
        
        return input;
    }

    public HtmlElement FormGroup(string label, HtmlElement input, string? error = null)
    {
        var nameAttr = input.Attributes.FirstOrDefault(a => a.Name == "name");
        var inputName = nameAttr.Name != null ? nameAttr.Value ?? "" : "";
        var group = new Div().Class("admin-form-group").Children(
            new Label().Class("admin-label").Attr("for", inputName).Text(label),
            input
        );
        
        if (error != null)
            group.AddChild(new Span().Class("admin-error").Text(error));
        
        return group;
    }

    public HtmlElement Alert(string message, AlertType type = AlertType.Info)
    {
        var className = type switch
        {
            AlertType.Success => "admin-alert admin-alert-success",
            AlertType.Warning => "admin-alert admin-alert-warning",
            AlertType.Error => "admin-alert admin-alert-error",
            _ => "admin-alert admin-alert-info"
        };
        
        return new Div().Class(className).Text(message);
    }

    public HtmlElement Table(IEnumerable<string> headers, IEnumerable<IEnumerable<HtmlElement>> rows)
    {
        var thead = new Thead().Children(
            new Tr().Children(headers.Select(h => new Th().Text(h)).ToArray())
        );

        var tbody = new Tbody().Children(
            rows.Select(row => new Tr().Children(
                row.Select(cell => new Td().Children(cell)).ToArray()
            )).ToArray()
        );

        return new Div().Class("admin-table-container").Children(
            new Table().Class("admin-table").Children(thead, tbody)
        );
    }

    /// <summary>
    /// Create a sortable table with clickable headers
    /// </summary>
    public HtmlElement SortableTable(IEnumerable<SortableColumn> columns, IEnumerable<IEnumerable<HtmlElement>> rows, string baseUrl, string? currentSort, bool descending)
    {
        var headerCells = columns.Select(col =>
        {
            if (col.SortKey == null)
            {
                return new Th().Text(col.Label);
            }

            var isActive = currentSort == col.SortKey;
            var newOrder = isActive && !descending ? "desc" : "asc";
            var sortUrl = $"{baseUrl}&sort={col.SortKey}&order={newOrder}";
            
            var arrow = isActive ? (descending ? " ↓" : " ↑") : "";
            
            return new Th().Children(
                new A()
                    .Class("admin-sort-link" + (isActive ? " active" : ""))
                    .Attr("href", sortUrl)
                    .Text(col.Label + arrow)
            );
        }).ToArray();

        var thead = new Thead().Children(new Tr().Children(headerCells));

        var tbody = new Tbody().Children(
            rows.Select(row => new Tr().Children(
                row.Select(cell => new Td().Children(cell)).ToArray()
            )).ToArray()
        );

        return new Div().Class("admin-table-container").Children(
            new Table().Class("admin-table").Children(thead, tbody)
        );
    }

    /// <summary>
    /// Create pagination controls
    /// </summary>
    public HtmlElement Pagination(int currentPage, int pageSize, int totalCount, string baseUrl)
    {
        var totalPages = (int)Math.Ceiling(totalCount / (double)pageSize);
        
        if (totalPages <= 1)
            return new Div();

        var nav = new Div()
            .Class("admin-flex admin-flex-between admin-flex-center admin-mt-4 admin-pt-4")
            .Attr("style", "border-top: 1px solid var(--admin-border);");

        // Info text
        var startItem = (currentPage - 1) * pageSize + 1;
        var endItem = Math.Min(currentPage * pageSize, totalCount);
        var info = new Span()
            .Class("admin-text-muted admin-text-sm")
            .Text($"Showing {startItem}-{endItem} of {totalCount} items");

        // Page buttons
        var buttons = new Div().Class("admin-flex admin-gap-2");

        // Previous button
        if (currentPage > 1)
        {
            buttons.AddChild(
                new A()
                    .Class("admin-btn admin-btn-ghost admin-btn-sm")
                    .Attr("href", $"{baseUrl}&page={currentPage - 1}")
                    .Text("← Previous")
            );
        }
        else
        {
            buttons.AddChild(
                new Span()
                    .Class("admin-btn admin-btn-ghost admin-btn-sm admin-disabled")
                    .Text("← Previous")
            );
        }

        // Page numbers (show max 5 pages around current)
        var startPage = Math.Max(1, currentPage - 2);
        var endPage = Math.Min(totalPages, currentPage + 2);

        if (startPage > 1)
        {
            buttons.AddChild(
                new A()
                    .Class("admin-btn admin-btn-ghost admin-btn-sm")
                    .Attr("href", $"{baseUrl}&page=1")
                    .Text("1")
            );
            if (startPage > 2)
            {
                buttons.AddChild(new Span().Class("admin-text-muted admin-px-2").Text("..."));
            }
        }

        for (var i = startPage; i <= endPage; i++)
        {
            if (i == currentPage)
            {
                buttons.AddChild(
                    new Span()
                        .Class("admin-btn admin-btn-primary admin-btn-sm")
                        .Text(i.ToString())
                );
            }
            else
            {
                buttons.AddChild(
                    new A()
                        .Class("admin-btn admin-btn-ghost admin-btn-sm")
                        .Attr("href", $"{baseUrl}&page={i}")
                        .Text(i.ToString())
                );
            }
        }

        if (endPage < totalPages)
        {
            if (endPage < totalPages - 1)
            {
                buttons.AddChild(new Span().Class("admin-text-muted admin-px-2").Text("..."));
            }
            buttons.AddChild(
                new A()
                    .Class("admin-btn admin-btn-ghost admin-btn-sm")
                    .Attr("href", $"{baseUrl}&page={totalPages}")
                    .Text(totalPages.ToString())
            );
        }

        // Next button
        if (currentPage < totalPages)
        {
            buttons.AddChild(
                new A()
                    .Class("admin-btn admin-btn-ghost admin-btn-sm")
                    .Attr("href", $"{baseUrl}&page={currentPage + 1}")
                    .Text("Next →")
            );
        }
        else
        {
            buttons.AddChild(
                new Span()
                    .Class("admin-btn admin-btn-ghost admin-btn-sm admin-disabled")
                    .Text("Next →")
            );
        }

        nav.AddChild(info);
        nav.AddChild(buttons);

        return nav;
    }

    public HtmlElement Badge(string text, BadgeVariant variant = BadgeVariant.Default)
    {
        var className = variant switch
        {
            BadgeVariant.Success => "admin-badge admin-badge-success",
            BadgeVariant.Warning => "admin-badge admin-badge-warning",
            BadgeVariant.Error => "admin-badge admin-badge-error",
            BadgeVariant.Info => "admin-badge admin-badge-info",
            _ => "admin-badge"
        };
        
        return new Span().Class(className).Text(text);
    }

    private static string GetCss() => $$"""
        :root {
            --primary: {{PrimaryColor}};
            --bg-dark: {{BgDark}};
            --bg-darker: {{BgDarker}};
            --bg-card: {{BgCard}};
            --text-light: {{TextLight}};
            --text-muted: {{TextMuted}};
            --border-color: {{BorderColor}};
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        .admin-body {
            font-family: system-ui, -apple-system, sans-serif;
            background-color: var(--bg-darker);
            color: var(--text-light);
            line-height: 1.5;
            min-height: 100vh;
        }

        /* Layout */
        .admin-layout {
            display: flex;
            min-height: 100vh;
        }

        .admin-sidebar {
            width: 260px;
            background-color: var(--bg-dark);
            border-right: 1px solid var(--border-color);
            padding: 1rem 0;
            position: fixed;
            height: 100vh;
            overflow-y: auto;
        }

        .admin-main {
            flex: 1;
            margin-left: 260px;
            padding: 2rem;
        }

        .admin-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 2rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--border-color);
        }

        .admin-logo {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--primary);
            padding: 0 1.5rem 1rem;
            border-bottom: 1px solid var(--border-color);
            margin-bottom: 1rem;
        }

        /* Navigation */
        .admin-nav { list-style: none; }
        
        .admin-nav-item {
            padding: 0.75rem 1.5rem;
            color: var(--text-muted);
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 0.75rem;
            transition: all 0.2s;
        }
        
        .admin-nav-item:hover, .admin-nav-item.active {
            background-color: var(--bg-card);
            color: var(--text-light);
        }

        .admin-nav-section {
            padding: 1rem 1.5rem 0.5rem;
            font-size: 0.75rem;
            text-transform: uppercase;
            color: var(--text-muted);
            letter-spacing: 0.05em;
        }

        /* Cards */
        .admin-card {
            background-color: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            margin-bottom: 1.5rem;
        }

        .admin-card-header {
            padding: 1rem 1.5rem;
            border-bottom: 1px solid var(--border-color);
        }

        .admin-card-title {
            font-size: 1.125rem;
            font-weight: 600;
        }

        .admin-card-body { padding: 1.5rem; }

        /* Buttons */
        .admin-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0.5rem 1rem;
            border-radius: 0.375rem;
            font-size: 0.875rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            border: none;
            text-decoration: none;
            gap: 0.5rem;
        }

        .admin-btn-primary {
            background-color: var(--primary);
            color: white;
        }
        .admin-btn-primary:hover { filter: brightness(1.1); }

        .admin-btn-secondary {
            background-color: var(--bg-card);
            border: 1px solid var(--border-color);
            color: var(--text-light);
        }
        .admin-btn-secondary:hover { background-color: var(--border-color); }

        .admin-btn-danger {
            background-color: #ef4444;
            color: white;
        }
        .admin-btn-danger:hover { filter: brightness(1.1); }

        .admin-btn-success {
            background-color: #22c55e;
            color: white;
        }
        .admin-btn-success:hover { filter: brightness(1.1); }

        .admin-btn-ghost {
            background: transparent;
            color: var(--text-muted);
        }
        .admin-btn-ghost:hover { color: var(--text-light); background: var(--bg-card); }

        /* Form elements */
        .admin-form-group { margin-bottom: 1rem; }

        .admin-label {
            display: block;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 0.375rem;
            color: var(--text-light);
        }

        .admin-input, .admin-select, .admin-textarea {
            width: 100%;
            padding: 0.5rem 0.75rem;
            background-color: var(--bg-dark);
            border: 1px solid var(--border-color);
            border-radius: 0.375rem;
            color: var(--text-light);
            font-size: 0.875rem;
        }

        .admin-input:focus, .admin-select:focus, .admin-textarea:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
        }

        .admin-textarea { min-height: 100px; resize: vertical; }

        .admin-error {
            color: #ef4444;
            font-size: 0.75rem;
            margin-top: 0.25rem;
            display: block;
        }

        /* Alerts */
        .admin-alert {
            padding: 0.75rem 1rem;
            border-radius: 0.375rem;
            margin-bottom: 1rem;
            border: 1px solid;
        }

        .admin-alert-info {
            background-color: rgba(59, 130, 246, 0.1);
            border-color: rgba(59, 130, 246, 0.3);
            color: #93c5fd;
        }

        .admin-alert-success {
            background-color: rgba(34, 197, 94, 0.1);
            border-color: rgba(34, 197, 94, 0.3);
            color: #86efac;
        }

        .admin-alert-warning {
            background-color: rgba(234, 179, 8, 0.1);
            border-color: rgba(234, 179, 8, 0.3);
            color: #fde047;
        }

        .admin-alert-error {
            background-color: rgba(239, 68, 68, 0.1);
            border-color: rgba(239, 68, 68, 0.3);
            color: #fca5a5;
        }

        /* Tables */
        .admin-table-container { overflow-x: auto; }

        .admin-table {
            width: 100%;
            border-collapse: collapse;
        }

        .admin-table th, .admin-table td {
            padding: 0.75rem 1rem;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }

        .admin-table th {
            font-weight: 600;
            color: var(--text-muted);
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .admin-table tr:hover { background-color: var(--bg-dark); }

        /* Sortable table headers */
        .admin-sort-link {
            color: var(--text-muted);
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
        }
        .admin-sort-link:hover { color: var(--text-light); }
        .admin-sort-link.active { color: var(--primary); }

        /* Disabled state */
        .admin-disabled {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
        }

        .admin-px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }

        /* Badges */
        .admin-badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            font-size: 0.75rem;
            font-weight: 500;
            border-radius: 9999px;
            background-color: var(--bg-dark);
            color: var(--text-muted);
        }

        .admin-badge-success { background-color: rgba(34, 197, 94, 0.2); color: #86efac; }
        .admin-badge-warning { background-color: rgba(234, 179, 8, 0.2); color: #fde047; }
        .admin-badge-error { background-color: rgba(239, 68, 68, 0.2); color: #fca5a5; }
        .admin-badge-info { background-color: rgba(59, 130, 246, 0.2); color: #93c5fd; }

        /* Grid */
        .admin-grid { display: grid; gap: 1.5rem; }
        .admin-grid-2 { grid-template-columns: repeat(2, 1fr); }
        .admin-grid-3 { grid-template-columns: repeat(3, 1fr); }
        .admin-grid-4 { grid-template-columns: repeat(4, 1fr); }

        /* Utilities */
        .admin-flex { display: flex; }
        .admin-flex-between { justify-content: space-between; }
        .admin-flex-center { align-items: center; }
        .admin-gap-2 { gap: 0.5rem; }
        .admin-gap-4 { gap: 1rem; }
        .admin-mb-4 { margin-bottom: 1rem; }
        .admin-mb-6 { margin-bottom: 1.5rem; }
        .admin-text-muted { color: var(--text-muted); }
        .admin-text-sm { font-size: 0.875rem; }

        /* Stats cards */
        .admin-stat {
            display: flex;
            flex-direction: column;
        }

        .admin-stat-value {
            font-size: 2rem;
            font-weight: 700;
            color: var(--text-light);
        }

        .admin-stat-label {
            font-size: 0.875rem;
            color: var(--text-muted);
        }

        /* HTMX loading indicator */
        .htmx-indicator { display: none; }
        .htmx-request .htmx-indicator { display: inline-block; }
        .htmx-request.htmx-indicator { display: inline-block; }
        
        .admin-loading {
            color: var(--primary);
            animation: pulse 1.5s ease-in-out infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        /* HTMX swap transitions */
        .htmx-swapping {
            opacity: 0.5;
            transition: opacity 0.2s ease-out;
        }
        
        .htmx-settling {
            opacity: 1;
            transition: opacity 0.2s ease-in;
        }

        @media (max-width: 768px) {
            .admin-sidebar { display: none; }
            .admin-main { margin-left: 0; }
            .admin-grid-2, .admin-grid-3, .admin-grid-4 { grid-template-columns: 1fr; }
        }
        """;
}
