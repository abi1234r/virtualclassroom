from flask import Flask, render_template, request, redirect, session, url_for, flash, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
import uuid
import os

app = Flask(__name__)

#  Use environment variables for sensitive keys or a fallback for local development
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-key-12345")

#  In Cloud Run, /tmp is the only writable directory for temporary file storage
UPLOAD_FOLDER = '/tmp/uploads'
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)
    
#  Initialize SocketIO with eventlet for high-performance real-time communication
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

active_meetings = set()

@app.route('/', methods=['GET', 'POST'])
def index():
    user = session.get('user')
    return render_template('index.html', user=user)

@app.route('/logout')
def logout():
    session.clear()
    return redirect('/')

@app.route('/upload_file/<room_id>', methods=['POST'])
def upload_file(room_id):
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file:
        filename = secure_filename(file.filename)
        unique_filename = f"{uuid.uuid4()}_{filename}"
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], unique_filename))
        
        socketio.emit('file-shared', {
            'filename': filename,
            'url': url_for('download_file', filename=unique_filename),
            'sender': session.get('user', 'Anonymous')
        }, room=room_id)
        
        return jsonify({'success': True, 'filename': filename})

@app.route('/download_file/<filename>')
def download_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route('/create_meeting', methods=['POST'])
def create_meeting_flow():
    name = request.form.get('name')
    if not name or not all(c.isalpha() or c.isspace() for c in name):
        return render_template('index.html', user=session.get('user'), error="Name must contain only alphabets and spaces")
    password = request.form.get('password')
    if password == "1@#1#23":
        room_id = uuid.uuid4().hex[:8]
        active_meetings.add(room_id)
        session['user'] = name
        session['role'] = 'teacher'
        return redirect(f'/meeting/{room_id}')
    else:
        return render_template('index.html', user=session.get('user'), error="Incorrect password")

@app.route('/join_meeting', methods=['POST'])
def join_meeting_flow():
    name = request.form.get('name')
    if not name or not all(c.isalpha() or c.isspace() for c in name):
        return render_template('index.html', user=session.get('user'), error="Name must contain only alphabets and spaces")
    room_id = request.form.get('room_id')
    if room_id in active_meetings:
        session['user'] = name
        session['role'] = 'student'
        return redirect(f'/meeting/{room_id}')
    else:
        return render_template('index.html', user=session.get('user'), error="Meeting ID not found")

@app.route('/meeting/<room_id>')
def meeting(room_id):
    if room_id not in active_meetings:
         return redirect(url_for('index', error="Meeting has ended."))
    return render_template('meeting.html', room=room_id, user=session.get('user', 'Guest'), 
                           role=session.get('role', 'student'), picture=session.get('picture', ''))

# Room user tracking
room_users = {}

@socketio.on('join')
def on_join(data):
    room = data['room']
    sid = request.sid
    username = session.get('user', 'Guest')
    picture = session.get('picture', '')

    if room not in room_users:
        room_users[room] = []

    # Get existing users in room
    existing_users = room_users[room][:]
    
    # Store user info
    user_info = {'sid': sid, 'username': username, 'picture': picture}
    room_users[room].append(user_info)
    
    join_room(room)
    
    # Inform the new user about existing users
    emit('all-users', existing_users)
    
    # Inform existing users about the new user
    emit('new-user', user_info, room=room, skip_sid=sid)

@socketio.on('signal')
def on_signal(data):
    sid = request.sid
    emit('signal', {'from': sid, 'signal': data['signal']}, room=data['to'])

@socketio.on('chat')
def on_chat(data):
    room = data['room']
    sid = request.sid
    username = session.get('user', 'Guest')
    picture = session.get('picture', '')
    role = session.get('role', 'student')
    emit('chat', {'msg': data['msg'], 'sid': sid, 'username': username, 'picture': picture, 'role': role}, room=room, skip_sid=sid)

@socketio.on('video-filter')
def on_filter(data):
    room = data['room']
    sid = request.sid
    emit('video-filter', {'sid': sid, 'filter': data['filter']}, room=room, skip_sid=sid)

@socketio.on('raise-hand')
def on_hand(data):
    room = data['room']
    sid = request.sid
    username = session.get('user', 'Guest')
    emit('raise-hand', {'sid': sid, 'username': username}, room=room)

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for room, users in room_users.items():
        found = False
        for user in users:
            if user['sid'] == sid:
                username = user['username']
                users.remove(user)
                emit('user-left', {'sid': sid, 'username': username}, room=room)
                found = True
                break
        if found: break

@socketio.on('leave-room')
def on_leave_room(data):
    room = data.get('room')
    sid = request.sid
    username = session.get('user', 'Guest')
    leave_room(room)
    if room in room_users:
        room_users[room] = [u for u in room_users[room] if u['sid'] != sid]
    emit('user-left', {'sid': sid, 'username': username}, room=room)

@app.route('/end_meeting/<room_id>', methods=['POST'])
def end_meeting(room_id):
    if session.get('role') == 'teacher':
        active_meetings.discard(room_id)
        socketio.emit('meeting-ended', to=room_id)
        if room_id in room_users:
            del room_users[room_id]
        return jsonify({'success': True})
    return jsonify({'success': False, 'error': 'Unauthorized'}), 403

if __name__ == '__main__':
    # Cloud Run assigns a port via environment variable 
    port = int(os.environ.get('PORT', 8080))
    socketio.run(app, host='0.0.0.0', port=port)
