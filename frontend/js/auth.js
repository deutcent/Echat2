const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');

if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // Simulate login
        alert('Logged in successfully!');
        window.location.href = 'index.html';
    });
}

if (registerForm) {
    registerForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // Simulate registration
        alert('Registered successfully!');
        window.location.href = 'login.html';
    });
}
