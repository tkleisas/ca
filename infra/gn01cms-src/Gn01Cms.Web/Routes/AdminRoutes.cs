using Gn01Cms.Admin.Pages;
using Gn01Cms.Auth;
using Gn01Cms.Cms;
using Gn01Cms.Data.Entities;
using Gn01Cms.Data.Repositories;
using Gn01Cms.Plugins;
using Serilog;

namespace Gn01Cms.Web.Routes;

public static class AdminRoutes
{
    public static WebApplication MapAdminRoutes(this WebApplication app)
    {
        // Admin login page
        app.MapGet("/admin/login", (LoginPage loginPage, HttpContext ctx) =>
        {
            var error = ctx.Request.Query["error"].FirstOrDefault();
            var returnUrl = ctx.Request.Query["returnUrl"].FirstOrDefault();
            return Results.Content(loginPage.Render(error, returnUrl), "text/html");
        });

        // Admin login POST
        app.MapPost("/admin/login", async (HttpContext ctx, IAuthService authService) =>
        {
            var form = await ctx.Request.ReadFormAsync();
            var username = form["username"].ToString();
            var password = form["password"].ToString();
            var returnUrl = form["returnUrl"].ToString();

            Log.Information("Login attempt for user: {Username}", username);
            
            var result = await authService.AuthenticateAsync(username, password, 
                ctx.Connection.RemoteIpAddress?.ToString(), 
                ctx.Request.Headers.UserAgent);
            
            Log.Information("Auth result: Success={Success}, Error={Error}", result.Success, result.Error);
            
            if (!result.Success || result.Session == null)
            {
                return Results.Redirect($"/admin/login?error={Uri.EscapeDataString(result.Error ?? "Invalid credentials")}&returnUrl={Uri.EscapeDataString(returnUrl ?? "/admin")}");
            }

            // Set session cookie
            var sessionOptions = ctx.RequestServices.GetRequiredService<Gn01Cms.Auth.SessionOptions>();
            ctx.Response.Cookies.Append(sessionOptions.CookieName, result.Session.SessionToken, new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Lax,
                Expires = result.Session.ExpiresAt
            });

            return Results.Redirect(string.IsNullOrEmpty(returnUrl) ? "/admin" : returnUrl);
        });

        // Admin logout
        app.MapPost("/admin/logout", async (HttpContext ctx, IAuthService authService) =>
        {
            var sessionOptions = ctx.RequestServices.GetRequiredService<Gn01Cms.Auth.SessionOptions>();
            var token = ctx.Request.Cookies[sessionOptions.CookieName];
            
            if (!string.IsNullOrEmpty(token))
            {
                var sessionService = ctx.RequestServices.GetRequiredService<ISessionService>();
                var session = await sessionService.ValidateSessionAsync(token);
                if (session != null)
                {
                    await authService.LogoutAsync(session.Id);
                }
                ctx.Response.Cookies.Delete(sessionOptions.CookieName);
            }

            return Results.Redirect("/admin/login");
        });

        // Admin dashboard
        app.MapGet("/admin", async (DashboardPage dashboardPage, ICurrentUser currentUser, IContentService contentService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin");

            var stats = new DashboardStats
            {
                ContentCount = 0,
                RecentContent = 0,
                UserCount = 1,
                ActiveUsers = 1,
                FileCount = 0,
                TotalFileSize = 0,
                TypeCount = 0,
                RecentItems = Array.Empty<ContentItem>()
            };

            return Results.Content(await dashboardPage.RenderAsync(stats), "text/html");
        });

        // Content Types Routes
        MapContentTypesRoutes(app);

        // Content Routes
        MapContentRoutes(app);

        // Users Routes
        MapUsersRoutes(app);

        // Files Routes
        MapFilesRoutes(app);

        // Roles Routes
        MapRolesRoutes(app);

        // Plugins Routes
        MapPluginsRoutes(app);

        // Settings Routes
        MapSettingsRoutes(app);

        return app;
    }

    private static void MapContentTypesRoutes(WebApplication app)
    {
        app.MapGet("/admin/types", async (ContentTypesPage page, ICurrentUser currentUser, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/types");

            var types = await typeService.ListAsync();
            return Results.Content(await page.RenderAsync(types), "text/html");
        });

        app.MapGet("/admin/types/new", async (ContentTypeEditPage page, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/types/new");

            return Results.Content(await page.RenderAsync(), "text/html");
        });

        app.MapPost("/admin/types/new", async (HttpContext ctx, ContentTypeEditPage page, ICurrentUser currentUser, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var form = await ctx.Request.ReadFormAsync();
            var request = new ContentTypeRequest
            {
                Name = form["name"].ToString(),
                Slug = form["slug"].ToString(),
                Description = form["description"].ToString(),
                Icon = form["icon"].ToString(),
                Schema = System.Text.Json.Nodes.JsonNode.Parse(form["schema"].ToString())?.AsObject() ?? new System.Text.Json.Nodes.JsonObject()
            };

            try
            {
                await typeService.CreateAsync(request);
                return Results.Redirect("/admin/types");
            }
            catch (Exception ex)
            {
                var contentType = new ContentType
                {
                    Name = request.Name,
                    Slug = request.Slug,
                    Description = request.Description,
                    Icon = request.Icon,
                    Schema = form["schema"].ToString()
                };
                return Results.Content(await page.RenderAsync(contentType, ex.Message), "text/html");
            }
        });

        app.MapGet("/admin/types/{id:int}", async (int id, ContentTypeEditPage page, ICurrentUser currentUser, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect($"/admin/login?returnUrl=/admin/types/{id}");

            var contentType = await typeService.GetAsync(id);
            if (contentType == null)
                return Results.NotFound();

            return Results.Content(await page.RenderAsync(contentType), "text/html");
        });

        app.MapPost("/admin/types/{id:int}/delete", async (int id, ICurrentUser currentUser, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            try
            {
                await typeService.DeleteAsync(id);
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "Failed to delete content type {Id}", id);
            }
            return Results.Redirect("/admin/types");
        });

        app.MapPost("/admin/types/{id:int}", async (int id, HttpContext ctx, ContentTypeEditPage page, ICurrentUser currentUser, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var contentType = await typeService.GetAsync(id);
            if (contentType == null)
                return Results.NotFound();

            var form = await ctx.Request.ReadFormAsync();
            var request = new ContentTypeRequest
            {
                Name = form["name"].ToString(),
                Slug = form["slug"].ToString(),
                Description = form["description"].ToString(),
                Icon = form["icon"].ToString(),
                Schema = System.Text.Json.Nodes.JsonNode.Parse(form["schema"].ToString())?.AsObject() ?? new System.Text.Json.Nodes.JsonObject()
            };

            try
            {
                await typeService.UpdateAsync(id, request);
                return Results.Redirect("/admin/types");
            }
            catch (Exception ex)
            {
                contentType.Name = request.Name;
                contentType.Slug = request.Slug;
                contentType.Description = request.Description;
                contentType.Icon = request.Icon;
                contentType.Schema = form["schema"].ToString();
                return Results.Content(await page.RenderAsync(contentType, ex.Message), "text/html");
            }
        });
    }

    private static void MapContentRoutes(WebApplication app)
    {
        app.MapGet("/admin/content", async (HttpContext ctx, ContentListPage page, ICurrentUser currentUser, IContentService contentService, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/content");

            var typeIdStr = ctx.Request.Query["type"].FirstOrDefault();
            int? typeId = int.TryParse(typeIdStr, out var tid) ? tid : null;

            var pageStr = ctx.Request.Query["page"].FirstOrDefault();
            int currentPage = int.TryParse(pageStr, out var p) && p > 0 ? p : 1;
            const int pageSize = 20;

            // Sorting
            var sort = ctx.Request.Query["sort"].FirstOrDefault() ?? "updated_at";
            var order = ctx.Request.Query["order"].FirstOrDefault() ?? "desc";
            bool descending = order.Equals("desc", StringComparison.OrdinalIgnoreCase);

            // Check if this is an HTMX partial request
            var isPartial = ctx.Request.Query["partial"].FirstOrDefault() == "1" ||
                           ctx.Request.Headers.ContainsKey("HX-Request");

            var types = await typeService.ListAsync();
            
            var query = new ContentQuery 
            { 
                Limit = pageSize, 
                Offset = (currentPage - 1) * pageSize, 
                OrderBy = sort,
                Descending = descending 
            };
            
            IEnumerable<ContentItem> items;
            int totalCount;
            
            if (typeId.HasValue)
            {
                items = await contentService.ListAsync(typeId.Value, query);
                totalCount = await contentService.CountAsync(typeId.Value);
            }
            else
            {
                items = await contentService.ListAllAsync(query);
                totalCount = await contentService.CountAllAsync();
            }

            // Return partial HTML for HTMX requests, full page otherwise
            if (isPartial)
            {
                return Results.Content(page.RenderPartial(items, types, typeId, currentPage, pageSize, totalCount, sort, descending), "text/html");
            }

            return Results.Content(await page.RenderAsync(items, types, typeId, currentPage, pageSize, totalCount, sort, descending), "text/html");
        });

        app.MapGet("/admin/content/new", async (HttpContext ctx, ContentEditPage page, ICurrentUser currentUser, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var typeIdStr = ctx.Request.Query["type"].FirstOrDefault();
            if (!int.TryParse(typeIdStr, out var typeId))
                return Results.Redirect("/admin/content");

            var contentType = await typeService.GetAsync(typeId);
            if (contentType == null)
                return Results.NotFound();

            return Results.Content(await page.RenderAsync(contentType), "text/html");
        });

        app.MapPost("/admin/content/new", async (HttpContext ctx, ContentEditPage page, ICurrentUser currentUser, IContentService contentService, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var typeIdStr = ctx.Request.Query["type"].FirstOrDefault();
            if (!int.TryParse(typeIdStr, out var typeId))
                return Results.Redirect("/admin/content");

            var contentType = await typeService.GetAsync(typeId);
            if (contentType == null)
                return Results.NotFound();

            var form = await ctx.Request.ReadFormAsync();
            
            var dataObj = new System.Text.Json.Nodes.JsonObject();
            foreach (var key in form.Keys.Where(k => k.StartsWith("field_")))
            {
                var fieldName = key.Substring(6);
                var fieldValue = form[key].ToString().Trim();
                
                // Try to parse as JSON if it looks like JSON (array or object)
                if (!string.IsNullOrEmpty(fieldValue) && 
                    ((fieldValue.StartsWith("[") && fieldValue.EndsWith("]")) ||
                     (fieldValue.StartsWith("{") && fieldValue.EndsWith("}"))))
                {
                    try
                    {
                        // Parse as JsonElement first, then convert to JsonNode to avoid parent issues
                        using var doc = System.Text.Json.JsonDocument.Parse(fieldValue);
                        var jsonNode = System.Text.Json.Nodes.JsonNode.Parse(doc.RootElement.GetRawText());
                        dataObj.Add(fieldName, jsonNode);
                    }
                    catch
                    {
                        // If JSON parsing fails, treat as string
                        dataObj.Add(fieldName, System.Text.Json.Nodes.JsonValue.Create(fieldValue));
                    }
                }
                else
                {
                    dataObj.Add(fieldName, System.Text.Json.Nodes.JsonValue.Create(fieldValue));
                }
            }

            var request = new CreateContentRequest
            {
                TypeId = typeId,
                Slug = form["slug"].ToString(),
                Status = form["status"].ToString(),
                Data = dataObj
            };

            try
            {
                await contentService.CreateAsync(request);
                return Results.Redirect($"/admin/content?type={typeId}");
            }
            catch (Exception ex)
            {
                var item = new ContentItem
                {
                    TypeId = typeId,
                    Slug = request.Slug,
                    Status = request.Status,
                    Data = dataObj.ToJsonString()
                };
                return Results.Content(await page.RenderAsync(contentType, item, ex.Message), "text/html");
            }
        });

        app.MapGet("/admin/content/{id:int}", async (int id, ContentEditPage page, ICurrentUser currentUser, IContentService contentService, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect($"/admin/login?returnUrl=/admin/content/{id}");

            var item = await contentService.GetAsync(id);
            if (item == null)
                return Results.NotFound();

            var contentType = await typeService.GetAsync(item.TypeId);
            if (contentType == null)
                return Results.NotFound();

            return Results.Content(await page.RenderAsync(contentType, item), "text/html");
        });

        app.MapPost("/admin/content/{id:int}", async (int id, HttpContext ctx, ContentEditPage page, ICurrentUser currentUser, IContentService contentService, IContentTypeService typeService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var item = await contentService.GetAsync(id);
            if (item == null)
                return Results.NotFound();

            var contentType = await typeService.GetAsync(item.TypeId);
            if (contentType == null)
                return Results.NotFound();

            var form = await ctx.Request.ReadFormAsync();
            var dataObj = new System.Text.Json.Nodes.JsonObject();
            foreach (var key in form.Keys.Where(k => k.StartsWith("field_")))
            {
                var fieldName = key.Substring(6);
                var fieldValue = form[key].ToString().Trim();
                
                // Try to parse as JSON if it looks like JSON (array or object)
                if (!string.IsNullOrEmpty(fieldValue) && 
                    ((fieldValue.StartsWith("[") && fieldValue.EndsWith("]")) ||
                     (fieldValue.StartsWith("{") && fieldValue.EndsWith("}"))))
                {
                    try
                    {
                        // Parse as JsonElement first, then convert to JsonNode to avoid parent issues
                        using var doc = System.Text.Json.JsonDocument.Parse(fieldValue);
                        var jsonNode = System.Text.Json.Nodes.JsonNode.Parse(doc.RootElement.GetRawText());
                        dataObj.Add(fieldName, jsonNode);
                    }
                    catch
                    {
                        // If JSON parsing fails, treat as string
                        dataObj.Add(fieldName, System.Text.Json.Nodes.JsonValue.Create(fieldValue));
                    }
                }
                else
                {
                    dataObj.Add(fieldName, System.Text.Json.Nodes.JsonValue.Create(fieldValue));
                }
            }

            var status = form["status"].ToString();
            if (form["action"] == "publish")
            {
                status = "published";
            }

            var request = new UpdateContentRequest
            {
                Slug = form["slug"].ToString(),
                Status = status,
                Data = dataObj
            };

            try
            {
                await contentService.UpdateAsync(id, request);
                return Results.Redirect($"/admin/content?type={item.TypeId}");
            }
            catch (Exception ex)
            {
                var logger = ctx.RequestServices.GetRequiredService<ILogger<Program>>();
                logger.LogError(ex, "Failed to update content {Id}: {Message}", id, ex.Message);
                item.Slug = request.Slug ?? item.Slug;
                item.Status = request.Status ?? item.Status;
                item.Data = dataObj.ToJsonString();
                return Results.Content(await page.RenderAsync(contentType, item, ex.Message), "text/html");
            }
        });
    }

    private static void MapUsersRoutes(WebApplication app)
    {
        app.MapGet("/admin/users", async (HttpContext ctx, UsersPage page, ICurrentUser currentUser, IUserRepository userRepo) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/users");

            var pageStr = ctx.Request.Query["page"].FirstOrDefault();
            int currentPage = int.TryParse(pageStr, out var p) && p > 0 ? p : 1;
            const int pageSize = 20;

            var sort = ctx.Request.Query["sort"].FirstOrDefault() ?? "created_at";
            var order = ctx.Request.Query["order"].FirstOrDefault() ?? "desc";
            bool descending = order.Equals("desc", StringComparison.OrdinalIgnoreCase);

            var users = await userRepo.GetPagedAsync(pageSize, (currentPage - 1) * pageSize, sort, descending);
            var totalCount = await userRepo.CountAsync();
            
            return Results.Content(await page.RenderAsync(users, currentPage, pageSize, totalCount, sort, descending), "text/html");
        });

        app.MapGet("/admin/users/new", async (UserEditPage page, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/users/new");

            return Results.Content(await page.RenderAsync(), "text/html");
        });

        app.MapPost("/admin/users/new", async (HttpContext ctx, UserEditPage page, ICurrentUser currentUser, IUserRepository userRepo, IPasswordHasher passwordHasher) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var form = await ctx.Request.ReadFormAsync();
            var password = form["password"].ToString();
            var passwordConfirm = form["passwordConfirm"].ToString();

            if (string.IsNullOrEmpty(password))
                return Results.Content(await page.RenderAsync(null, null, "Password is required"), "text/html");

            if (password != passwordConfirm)
                return Results.Content(await page.RenderAsync(null, null, "Passwords do not match"), "text/html");

            var user = new User
            {
                Username = form["username"].ToString(),
                Email = form["email"].ToString(),
                DisplayName = form["displayName"].ToString(),
                PasswordHash = passwordHasher.HashPassword(password),
                Status = form["status"].ToString()
            };

            try
            {
                await userRepo.InsertAsync(user);
                return Results.Redirect("/admin/users");
            }
            catch (Exception ex)
            {
                return Results.Content(await page.RenderAsync(user, null, ex.Message), "text/html");
            }
        });

        app.MapGet("/admin/users/{id:int}", async (int id, UserEditPage page, ICurrentUser currentUser, IUserRepository userRepo) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect($"/admin/login?returnUrl=/admin/users/{id}");

            var user = await userRepo.GetByIdAsync(id);
            if (user == null)
                return Results.NotFound();

            return Results.Content(await page.RenderAsync(user), "text/html");
        });

        app.MapPost("/admin/users/{id:int}", async (int id, HttpContext ctx, UserEditPage page, ICurrentUser currentUser, IUserRepository userRepo, IPasswordHasher passwordHasher) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var user = await userRepo.GetByIdAsync(id);
            if (user == null)
                return Results.NotFound();

            var form = await ctx.Request.ReadFormAsync();
            var password = form["password"].ToString();
            var passwordConfirm = form["passwordConfirm"].ToString();

            if (!string.IsNullOrEmpty(password))
            {
                if (password != passwordConfirm)
                    return Results.Content(await page.RenderAsync(user, null, "Passwords do not match"), "text/html");
                
                user.PasswordHash = passwordHasher.HashPassword(password);
            }

            user.Username = form["username"].ToString();
            user.Email = form["email"].ToString();
            user.DisplayName = form["displayName"].ToString();
            user.Status = form["status"].ToString();

            try
            {
                await userRepo.UpdateAsync(user);
                return Results.Redirect("/admin/users");
            }
            catch (Exception ex)
            {
                return Results.Content(await page.RenderAsync(user, null, ex.Message), "text/html");
            }
        });
    }

    private static void MapFilesRoutes(WebApplication app)
    {
        app.MapGet("/admin/files", async (HttpContext ctx, FilesPage page, IFileService fileService, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/files");

            // Pagination and sorting
            var pageNum = int.TryParse(ctx.Request.Query["page"], out var p) ? Math.Max(1, p) : 1;
            var sort = ctx.Request.Query["sort"].FirstOrDefault();
            var order = ctx.Request.Query["order"].FirstOrDefault() ?? "desc";
            var descending = order.Equals("desc", StringComparison.OrdinalIgnoreCase);
            var pageSize = 20;
            
            var totalCount = await fileService.CountAsync();
            var files = await fileService.ListAsync(new FileQuery
            {
                Limit = pageSize,
                Offset = (pageNum - 1) * pageSize,
                OrderBy = sort,
                Descending = descending
            });

            var html = await page.RenderAsync(files, pageNum, pageSize, totalCount, sort, descending);
            return Results.Content(html, "text/html");
        });

        app.MapPost("/admin/files/upload", async (HttpContext ctx, ICurrentUser currentUser, IFileService fileService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var form = await ctx.Request.ReadFormAsync();
            var file = form.Files.GetFile("file");
            
            if (file == null)
                return Results.Redirect("/admin/files");

            try
            {
                await fileService.UploadAsync(file);
                return Results.Redirect("/admin/files");
            }
            catch (Exception ex)
            {
                Log.Error(ex, "File upload failed");
                return Results.Redirect("/admin/files");
            }
        });

        app.MapPost("/admin/files/{id:int}/delete", async (int id, ICurrentUser currentUser, IFileService fileService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            await fileService.DeleteAsync(id);
            return Results.Redirect("/admin/files");
        });

        app.MapGet("/files/{id:int}", async (int id, IFileService fileService) =>
        {
            var file = await fileService.GetAsync(id);
            if (file == null)
                return Results.NotFound();

            var stream = await fileService.GetStreamAsync(id);
            if (stream == null)
                return Results.NotFound();

            return Results.File(stream, file.ContentType, file.OriginalName);
        });
    }

    private static void MapRolesRoutes(WebApplication app)
    {
        app.MapGet("/admin/roles", async (RolesPage page, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/roles");

            var html = await page.RenderAsync();
            return Results.Content(html, "text/html");
        });

        app.MapGet("/admin/roles/new", async (RoleEditPage page, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/roles/new");

            var html = await page.RenderAsync();
            return Results.Content(html, "text/html");
        });

        app.MapPost("/admin/roles", async (HttpContext ctx, ICurrentUser currentUser, IRoleService roleService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var form = await ctx.Request.ReadFormAsync();
            var role = new Role
            {
                Name = form["name"].ToString(),
                Description = form["description"].ToString()
            };

            var roleId = await roleService.CreateAsync(role);

            var permissionIds = form["permissions"]
                .Where(p => int.TryParse(p, out _))
                .Select(p => int.Parse(p!))
                .ToList();
            
            if (permissionIds.Any())
                await roleService.SetRolePermissionsAsync(roleId, permissionIds);

            return Results.Redirect("/admin/roles");
        });

        app.MapGet("/admin/roles/{id:int}", async (int id, RoleEditPage page, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect($"/admin/login?returnUrl=/admin/roles/{id}");

            var html = await page.RenderAsync(id);
            return Results.Content(html, "text/html");
        });

        app.MapPost("/admin/roles/{id:int}", async (int id, HttpContext ctx, ICurrentUser currentUser, IRoleService roleService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var form = await ctx.Request.ReadFormAsync();
            var role = await roleService.GetAsync(id);
            if (role == null)
                return Results.NotFound();

            role.Name = form["name"].ToString();
            role.Description = form["description"].ToString();
            await roleService.UpdateAsync(role);

            var permissionIds = form["permissions"]
                .Where(p => int.TryParse(p, out _))
                .Select(p => int.Parse(p!))
                .ToList();
            
            await roleService.SetRolePermissionsAsync(id, permissionIds);

            return Results.Redirect("/admin/roles");
        });

        app.MapPost("/admin/roles/{id:int}/delete", async (int id, ICurrentUser currentUser, IRoleService roleService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            await roleService.DeleteAsync(id);
            return Results.Redirect("/admin/roles");
        });
    }

    private static void MapPluginsRoutes(WebApplication app)
    {
        app.MapGet("/admin/plugins", async (PluginsPage page, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/plugins");

            var html = await page.RenderAsync();
            return Results.Content(html, "text/html");
        });

        app.MapPost("/admin/plugins/{id}/enable", async (string id, ICurrentUser currentUser, IPluginManager pluginManager) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            try
            {
                await pluginManager.EnablePluginAsync(id);
            }
            catch (Exception ex)
            {
                Log.Error(ex, "Failed to enable plugin {PluginId}", id);
            }
            
            return Results.Redirect("/admin/plugins");
        });

        app.MapPost("/admin/plugins/{id}/disable", async (string id, ICurrentUser currentUser, IPluginManager pluginManager) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            try
            {
                await pluginManager.DisablePluginAsync(id);
            }
            catch (Exception ex)
            {
                Log.Error(ex, "Failed to disable plugin {PluginId}", id);
            }
            
            return Results.Redirect("/admin/plugins");
        });

        app.MapGet("/admin/plugins/{id}/config", async (string id, PluginConfigPage page, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect($"/admin/login?returnUrl=/admin/plugins/{id}/config");

            var html = await page.RenderAsync(id);
            return Results.Content(html, "text/html");
        });

        app.MapPost("/admin/plugins/{id}/config", async (string id, HttpContext ctx, ICurrentUser currentUser, IPluginManager pluginManager) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var form = await ctx.Request.ReadFormAsync();
            var config = new Dictionary<string, object?>();
            
            foreach (var key in form.Keys.Where(k => k != "__RequestVerificationToken"))
            {
                config[key] = form[key].ToString();
            }

            await pluginManager.UpdateConfigAsync(id, config);
            return Results.Redirect("/admin/plugins");
        });
    }

    private static void MapSettingsRoutes(WebApplication app)
    {
        app.MapGet("/admin/settings", async (HttpContext ctx, SettingsPage page, IContentService contentService, IContentTypeService typeService, ICurrentUser currentUser) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login?returnUrl=/admin/settings");

            var group = ctx.Request.Query["group"].ToString();
            
            // Get published content for front page selector
            var contentItems = new List<ContentItemOption>();
            var types = await typeService.ListAsync();
            foreach (var type in types)
            {
                var items = await contentService.ListAsync(type.Id, new ContentQuery { Limit = 100, Status = "published" });
                foreach (var item in items)
                {
                    var dataDoc = System.Text.Json.JsonDocument.Parse(item.Data);
                    var title = dataDoc.RootElement.TryGetProperty("title", out var titleProp) 
                        ? titleProp.GetString() ?? $"Content #{item.Id}" 
                        : $"Content #{item.Id}";
                    contentItems.Add(new ContentItemOption { Id = item.Id, Title = title, TypeName = type.Name });
                }
            }
            
            var html = await page.RenderAsync(string.IsNullOrEmpty(group) ? null : group, contentItems);
            return Results.Content(html, "text/html");
        });

        app.MapPost("/admin/settings", async (HttpContext ctx, ICurrentUser currentUser, ISettingsService settingsService) =>
        {
            if (!currentUser.IsAuthenticated)
                return Results.Redirect("/admin/login");

            var form = await ctx.Request.ReadFormAsync();
            var group = form["group"].ToString();
            
            var settings = new Dictionary<string, string>();
            foreach (var key in form.Keys.Where(k => k != "group" && k != "__RequestVerificationToken"))
            {
                settings[key] = form[key].ToString();
            }

            await settingsService.SetManyAsync(settings);
            return Results.Redirect($"/admin/settings?group={group}");
        });
    }
}
