USE email_classifier;

CREATE TABLE email_classifications (
    id VARCHAR(36) PRIMARY KEY,
    subject VARCHAR(255),
    body TEXT,
    email_to VARCHAR(255),
    email_from VARCHAR(255),
    classification VARCHAR(50),
    human_classification VARCHAR(50),
    human_comment TEXT,
    has_human_review BOOLEAN DEFAULT FALSE,
    status VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
