/* A first frame independent of Electron/Chromium. Uses Electron's GTK3 runtime. */
#define _GNU_SOURCE
#include <gtk/gtk.h>
#include <glib-unix.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <stddef.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <math.h>
#include <string.h>

#define WIDTH 512
#define HEIGHT 332
#define MAX_CLIENTS 16

typedef struct { int fd; guint watch, timeout; pid_t pid; size_t used; char bytes[1024]; } Client;
static GtkWidget *window, *canvas;
static GdkPixbuf *icon;
static Client *controller;
static GPid child;
static char **child_argv, *socket_name;
static char status_text[768] = "正在启动 pSpore…";
static gboolean painted, started, handed_off, cancelling, animate = TRUE;
static guint animation_timer, kill_timer, clients;
static gint64 launch_time;

static void hide_window(void) {
  if (animation_timer) { g_source_remove(animation_timer); animation_timer = 0; }
  if (window) { GtkWidget *old = window; window = NULL; canvas = NULL; gtk_widget_destroy(old); }
}
static gboolean force_stop(gpointer unused) {
  (void)unused; kill_timer = 0;
  if (child) kill(-child, SIGKILL);
  return G_SOURCE_REMOVE;
}
static gboolean cancel_start(gpointer unused) {
  (void)unused;
  if (cancelling) return G_SOURCE_CONTINUE;
  cancelling = TRUE; hide_window();
  if (child) { kill(-child, SIGTERM); kill_timer = g_timeout_add(3000, force_stop, NULL); }
  else gtk_main_quit();
  return G_SOURCE_CONTINUE;
}
static gboolean delete_window(GtkWidget *widget, GdkEvent *event, gpointer data) {
  (void)widget; (void)event; (void)data; cancel_start(NULL); return TRUE;
}
static void close_clicked(GtkButton *button, gpointer data) { (void)button; (void)data; cancel_start(NULL); }
static gboolean key_press(GtkWidget *widget, GdkEventKey *event, gpointer data) {
  (void)widget; (void)data;
  if (event->keyval != GDK_KEY_Escape) return FALSE;
  cancel_start(NULL); return TRUE;
}
static gboolean drag_window(GtkWidget *widget, GdkEventButton *event, gpointer data) {
  (void)widget; (void)data;
  if (window && event->button == 1)
    gtk_window_begin_move_drag(GTK_WINDOW(window), 1, event->x_root, event->y_root, event->time);
  return TRUE;
}
static void rounded(cairo_t *cr, double x, double y, double w, double h, double r) {
  cairo_new_sub_path(cr);
  cairo_arc(cr, x+w-r, y+r, r, -G_PI/2, 0); cairo_arc(cr, x+w-r, y+h-r, r, 0, G_PI/2);
  cairo_arc(cr, x+r, y+h-r, r, G_PI/2, G_PI); cairo_arc(cr, x+r, y+r, r, G_PI, 3*G_PI/2);
  cairo_close_path(cr);
}
static void label(cairo_t *cr, const char *text, double x, double y, int size, gboolean bold, double r, double g, double b, int width) {
  PangoLayout *layout = pango_cairo_create_layout(cr);
  PangoFontDescription *font = pango_font_description_from_string(bold ? "Sans Semi-Bold" : "Sans");
  pango_font_description_set_absolute_size(font, size * PANGO_SCALE);
  pango_layout_set_font_description(layout, font); pango_layout_set_text(layout, text, -1);
  pango_layout_set_width(layout, width * PANGO_SCALE); pango_layout_set_ellipsize(layout, PANGO_ELLIPSIZE_END);
  cairo_set_source_rgb(cr, r,g,b); cairo_move_to(cr,x,y); pango_cairo_show_layout(cr,layout);
  pango_font_description_free(font); g_object_unref(layout);
}
static gboolean draw_card(GtkWidget *widget, cairo_t *cr, gpointer data) {
  (void)widget; (void)data;
  cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE); cairo_set_source_rgba(cr,0,0,0,0); cairo_paint(cr);
  cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
  for (int i=10;i>0;i--) { rounded(cr,16-i*.5,19-i*.3,480+i,300+i*.6,24+i*.5); cairo_set_source_rgba(cr,.18,.3,.29,.006); cairo_fill(cr); }
  rounded(cr,16,16,480,300,24); cairo_clip(cr);
  cairo_pattern_t *bg = cairo_pattern_create_linear(55,280,440,40);
  cairo_pattern_add_color_stop_rgb(bg,0,.93,.96,.90); cairo_pattern_add_color_stop_rgb(bg,.5,.973,.984,.969);
  cairo_pattern_add_color_stop_rgb(bg,1,.90,.94,.97); cairo_set_source(cr,bg); cairo_paint(cr); cairo_pattern_destroy(bg);
  cairo_reset_clip(cr);
  rounded(cr,16.5,16.5,479,299,24); cairo_set_source_rgba(cr,1,1,1,.86); cairo_set_line_width(cr,1); cairo_stroke(cr);
  if (icon) { gdk_cairo_set_source_pixbuf(cr,icon,54,64); cairo_paint(cr); }
  label(cr,"pSpore",162,71,34,TRUE,.22,.337,.345,270);
  label(cr,"让想法，自然生长",163,119,13,FALSE,.443,.533,.514,270);
  label(cr,status_text,54,189,12,FALSE,.431,.525,.506,355);
  double t = (g_get_monotonic_time()-launch_time)/1000000.0;
  for (int i=0;i<3;i++) { cairo_arc(cr,438+i*8,199,2,0,2*G_PI); cairo_set_source_rgba(cr,.533,.667,.627,animate?.55+.35*sin(t*4-i*.7):.7); cairo_fill(cr); }
  rounded(cr,54,220,404,3,1.5); cairo_set_source_rgb(cr,.855,.902,.875); cairo_fill_preserve(cr); cairo_clip(cr);
  double travel = animate ? (fmod(t,2.0)/2.0)*560-154 : 0;
  cairo_pattern_t *bar = cairo_pattern_create_linear(54+travel,0,208+travel,0);
  cairo_pattern_add_color_stop_rgb(bar,0,.74,.83,.75); cairo_pattern_add_color_stop_rgb(bar,.5,.51,.67,.64); cairo_pattern_add_color_stop_rgb(bar,1,.70,.80,.86);
  cairo_set_source(cr,bar); cairo_rectangle(cr,54+travel,220,animate?154:404,3); cairo_fill(cr); cairo_pattern_destroy(bar); cairo_reset_clip(cr);
  cairo_arc(cr,57,263,2.5,0,2*G_PI); cairo_set_source_rgb(cr,.61,.72,.64); cairo_fill(cr);
  label(cr,"本地优先 · 陪伴每一个灵感",66,255,10,FALSE,.54,.61,.59,265);
  label(cr,"DESKTOP",402,256,8,FALSE,.54,.61,.59,60);
  painted = TRUE; return FALSE;
}
static gboolean tick(gpointer data) { (void)data; if(canvas) gtk_widget_queue_draw(canvas); return G_SOURCE_CONTINUE; }
static void child_exited(GPid pid, gint result, gpointer data) {
  (void)data; g_spawn_close_pid(pid); child = 0;
  if (kill_timer) { g_source_remove(kill_timer); kill_timer=0; }
  if (window && !cancelling && !handed_off && (!WIFEXITED(result) || WEXITSTATUS(result)!=0)) {
    g_strlcpy(status_text,"启动失败，请从快捷方式菜单打开启动日志",sizeof status_text);
    animate=FALSE; if(canvas) gtk_widget_queue_draw(canvas);
    g_printerr("pSpore native startup: child exited with status %d\n",result);
  } else { hide_window(); gtk_main_quit(); }
}
static void child_setup(gpointer data) { (void)data; setsid(); }
static void spawn_electron(GdkFrameClock *clock, gpointer data) {
  (void)clock; (void)data;
  if (!painted || started || cancelling) return;
  started=TRUE;
  /* Flush the completed GTK frame before even spawning Electron. */
  gdk_display_sync(gtk_widget_get_display(window));
  g_printerr("pSpore native startup: first frame %.1f ms; starting Electron\n",(g_get_monotonic_time()-launch_time)/1000.0);
  gchar **env=g_get_environ(); env=g_environ_setenv(env,"PSPORE_STARTUP_SOCKET",socket_name,TRUE);
  GError *error=NULL;
  if (g_spawn_async(NULL,child_argv,env,G_SPAWN_DO_NOT_REAP_CHILD,child_setup,NULL,&child,&error)) {
    g_child_watch_add(child,child_exited,NULL);
  } else {
    g_printerr("pSpore native startup: %s\n",error->message); g_clear_error(&error);
    g_strlcpy(status_text,"无法启动 pSpore，请检查启动日志",sizeof status_text); animate=FALSE;
  }
  g_strfreev(env);
}
static gboolean send_line(Client *client, const char *line) {
  return send(client->fd,line,strlen(line),MSG_NOSIGNAL)==(ssize_t)strlen(line);
}
static void fallback_reaped(GPid pid,gint status,gpointer data) { (void)status;(void)data;g_spawn_close_pid(pid); }
static void activate(void) {
  if(window) { gtk_window_present(GTK_WINDOW(window)); return; }
  if(controller && send_line(controller,"FOCUS\n")) return;
  /* Also supports an older/directly started Electron instance. */
  gchar **env=g_get_environ(); env=g_environ_unsetenv(env,"PSPORE_STARTUP_SOCKET");
  GPid pid=0; GError *error=NULL;
  if(g_spawn_async(NULL,child_argv,env,G_SPAWN_DO_NOT_REAP_CHILD,NULL,NULL,&pid,&error)) g_child_watch_add(pid,fallback_reaped,NULL);
  else { g_printerr("pSpore native startup: %s\n",error->message);g_clear_error(&error); }
  g_strfreev(env);
}
static void free_client(gpointer data) {
  Client *client=data;
  if(controller==client) { controller=NULL; if(child) hide_window(); }
  if(client->timeout) g_source_remove(client->timeout);
  close(client->fd);g_free(client);clients--;
}
static gboolean expire_client(gpointer data) {
  Client *client=data;client->timeout=0;g_source_remove(client->watch);return G_SOURCE_REMOVE;
}
static gboolean read_client(gint fd,GIOCondition condition,gpointer data) {
  Client *client=data;
  if(condition & (G_IO_ERR|G_IO_NVAL)) return G_SOURCE_REMOVE;
  ssize_t count=recv(fd,client->bytes+client->used,sizeof(client->bytes)-1-client->used,0);
  if(count<0) return errno==EAGAIN?G_SOURCE_CONTINUE:G_SOURCE_REMOVE;
  if(count==0) return G_SOURCE_REMOVE;
  client->used+=(size_t)count;client->bytes[client->used]='\0';
  char *newline;
  while((newline=memchr(client->bytes,'\n',client->used))) {
    *newline='\0';size_t consumed=(size_t)(newline-client->bytes)+1;
    if(!strcmp(client->bytes,"ACTIVATE") && controller!=client) { activate();return G_SOURCE_REMOVE; }
    if(!strcmp(client->bytes,"HELLO") && child && client->pid==child && !controller) {
      controller=client;g_source_remove(client->timeout);client->timeout=0;
      if(!send_line(client,"WELCOME\n")) return G_SOURCE_REMOVE;
    } else if(controller==client && !strcmp(client->bytes,"HIDE")) { handed_off=TRUE;hide_window(); }
    else if(controller==client && g_str_has_prefix(client->bytes,"STATUS ") && g_utf8_validate(client->bytes+7,-1,NULL)) {
      g_strlcpy(status_text,client->bytes+7,sizeof status_text);if(canvas)gtk_widget_queue_draw(canvas);
    } else return G_SOURCE_REMOVE;
    client->used-=consumed;memmove(client->bytes,client->bytes+consumed,client->used);client->bytes[client->used]='\0';
  }
  return client->used==sizeof(client->bytes)-1?G_SOURCE_REMOVE:G_SOURCE_CONTINUE;
}
static gboolean accept_client(gint fd,GIOCondition condition,gpointer data) {
  (void)condition;(void)data;
  int peer=accept4(fd,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);
  if(peer<0)return G_SOURCE_CONTINUE;
  struct ucred cred;socklen_t size=sizeof cred;
  if(clients>=MAX_CLIENTS || getsockopt(peer,SOL_SOCKET,SO_PEERCRED,&cred,&size)<0 || cred.uid!=getuid()) { close(peer);return G_SOURCE_CONTINUE; }
  Client *client=g_new0(Client,1);client->fd=peer;client->pid=cred.pid;clients++;
  client->watch=g_unix_fd_add_full(G_PRIORITY_DEFAULT,peer,G_IO_IN|G_IO_HUP|G_IO_ERR,read_client,client,free_client);
  client->timeout=g_timeout_add(10000,expire_client,client);return G_SOURCE_CONTINUE;
}
static void direct_start(void) {
  unsetenv("PSPORE_STARTUP_SOCKET");execv(child_argv[0],child_argv);
  g_printerr("pSpore native startup: cannot execute application: %s\n",g_strerror(errno));
}
int main(int argc,char **argv) {
  launch_time=g_get_monotonic_time();
  if(argc<2 || argv[1][0]!='/') { g_printerr("Usage: pspore-startup /absolute/path/to/pspore-desktop [arguments]\n");return 2; }
  child_argv=argv+1;
  gchar *hash=g_compute_checksum_for_string(G_CHECKSUM_SHA256,g_get_user_config_dir(),-1);
  socket_name=g_strdup_printf("pspore-startup-%u-%.24s",(unsigned)getuid(),hash);g_free(hash);
  int server=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
  struct sockaddr_un address={.sun_family=AF_UNIX};memcpy(address.sun_path+1,socket_name,strlen(socket_name));
  socklen_t address_size=offsetof(struct sockaddr_un,sun_path)+1+strlen(socket_name);
  if(server<0) { direct_start();return 1; }
  if(bind(server,(struct sockaddr*)&address,address_size)<0) {
    int bind_error=errno;close(server);
    if(bind_error==EADDRINUSE) for(int attempt=0;attempt<5;attempt++) {
      int peer=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);
      if(peer<0)break;
      struct ucred cred;socklen_t size=sizeof cred;
      if(connect(peer,(struct sockaddr*)&address,address_size)==0 && getsockopt(peer,SOL_SOCKET,SO_PEERCRED,&cred,&size)==0 && cred.uid==getuid()) {
        ssize_t sent=send(peer,"ACTIVATE\n",9,MSG_NOSIGNAL);close(peer);if(sent==9)return 0;break;
      }
      close(peer);g_usleep(10000);
    }
    direct_start();return 1;
  }
  if(listen(server,MAX_CLIENTS)<0) { close(server);direct_start();return 1; }
  g_set_prgname("pspore");g_set_application_name("pSpore");
  if(!gtk_init_check(NULL,NULL)) { close(server);direct_start();return 1; }
  window=gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(window),"pSpore · 正在启动");
  gtk_window_set_default_size(GTK_WINDOW(window),WIDTH,HEIGHT);
  gtk_window_set_resizable(GTK_WINDOW(window),FALSE);gtk_window_set_decorated(GTK_WINDOW(window),FALSE);
  gtk_window_set_position(GTK_WINDOW(window),GTK_WIN_POS_CENTER);
  gtk_window_set_type_hint(GTK_WINDOW(window),GDK_WINDOW_TYPE_HINT_SPLASHSCREEN);
  gtk_window_set_skip_taskbar_hint(GTK_WINDOW(window),TRUE);gtk_window_set_skip_pager_hint(GTK_WINDOW(window),TRUE);
  gtk_widget_set_app_paintable(window,TRUE);
  GdkVisual *visual=gdk_screen_get_rgba_visual(gtk_widget_get_screen(window));if(visual)gtk_widget_set_visual(window,visual);
  g_signal_connect(window,"delete-event",G_CALLBACK(delete_window),NULL);
  g_signal_connect(window,"key-press-event",G_CALLBACK(key_press),NULL);
  char *app_dir=g_path_get_dirname(child_argv[0]);char *icon_path=g_build_filename(app_dir,"resources","icons","pspore.png",NULL);
  icon=gdk_pixbuf_new_from_file_at_scale(icon_path,86,86,TRUE,NULL);g_free(app_dir);g_free(icon_path);
  if(icon)gtk_window_set_icon(GTK_WINDOW(window),icon);
  GtkWidget *fixed=gtk_fixed_new();gtk_container_add(GTK_CONTAINER(window),fixed);
  canvas=gtk_drawing_area_new();gtk_widget_set_size_request(canvas,WIDTH,HEIGHT);gtk_fixed_put(GTK_FIXED(fixed),canvas,0,0);
  gtk_widget_add_events(canvas,GDK_BUTTON_PRESS_MASK);g_signal_connect(canvas,"draw",G_CALLBACK(draw_card),NULL);
  g_signal_connect(canvas,"button-press-event",G_CALLBACK(drag_window),NULL);
  GtkWidget *button=gtk_button_new_with_label("×");gtk_widget_set_name(button,"startup-close");
  gtk_widget_set_size_request(button,30,30);gtk_widget_set_tooltip_text(button,"取消启动 (Esc)");
  gtk_fixed_put(GTK_FIXED(fixed),button,453,29);g_signal_connect(button,"clicked",G_CALLBACK(close_clicked),NULL);
  GtkCssProvider *css=gtk_css_provider_new();
  gtk_css_provider_load_from_data(css,"#startup-close {padding:0;min-width:30px;min-height:30px;border:0;border-radius:15px;background:transparent;box-shadow:none;color:#7b9293;font:24px Sans;} #startup-close:hover,#startup-close:focus {background:#dfe9e6;color:#425d61;}",-1,NULL);
  gtk_style_context_add_provider(gtk_widget_get_style_context(button),GTK_STYLE_PROVIDER(css),GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);g_object_unref(css);
  g_object_get(gtk_settings_get_default(),"gtk-enable-animations",&animate,NULL);
  gtk_widget_show_all(window);
  g_signal_connect_after(gtk_widget_get_frame_clock(canvas),"after-paint",G_CALLBACK(spawn_electron),NULL);
  if(animate)animation_timer=g_timeout_add(33,tick,NULL);
  guint listener=g_unix_fd_add(server,G_IO_IN,accept_client,NULL);
  g_unix_signal_add(SIGTERM,cancel_start,NULL);g_unix_signal_add(SIGINT,cancel_start,NULL);
  gtk_main();g_source_remove(listener);close(server);if(icon)g_object_unref(icon);g_free(socket_name);return 0;
}
