/**
 * Supernova AI — Quiz Client-Side Module
 * Handles rendering the interactive 4-question Quick Quiz in the chat view
 * and rendering stored quiz summary cards from previous sessions.
 */
export function getQuizClientScript(): string {
  return `
    /**
     * Renders a compact summary card for a stored quiz turn on session restore.
     * e.g. "Quiz result: 3 of 4 · Revisit: File Linking"
     */
    function renderStoredQuizCard(text) {
      let data = { correct: 0, total: 4, missedConcepts: [] };
      try {
        data = JSON.parse(text);
      } catch (e) {}

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'quiz-summary-card';

      const icon = document.createElement('span');
      icon.textContent = '🎯';
      card.appendChild(icon);

      const total = data.total || 4;
      const textSpan = document.createElement('span');
      let label = 'Quiz result: ' + (data.correct != null ? data.correct : 0) + ' of ' + total;
      if (Array.isArray(data.missedConcepts) && data.missedConcepts.length > 0) {
        label += ' · Revisit: ' + data.missedConcepts.join(', ');
      } else if (data.correct === total) {
        label += ' · All concepts solid!';
      }
      textSpan.textContent = label;
      card.appendChild(textSpan);

      row.appendChild(card);
      messagesContainer.appendChild(row);
    }

    /**
     * Renders the interactive 4-question Quick Quiz in the chat.
     * - Card renders 1 question at a time with header progress text ("Question N of 4").
     * - Code snippet displayed in <pre><code> with horizontal scroll.
     * - Options in role="radiogroup" with role="radio" and aria-checked.
     * - Keyboard navigation: Arrow keys move, Enter/Space selects, 1-4 selects directly.
     * - Selecting an option locks question, reveals text label ("✓ Correct" or "✕ Not quite"),
     *   correct answer when wrong, and explanation.
     * - "Next" button (or "See results" on question 4).
     * - "Skip quiz" link to dismiss without saving.
     * - Results card with score encouragement, concepts to revisit chips (fill input on click),
     *   and Retake / Harder buttons.
     */
    function renderQuizCard(quizQuestions, level) {
      if (!Array.isArray(quizQuestions) || quizQuestions.length === 0) {
        return;
      }

      const totalQuestions = quizQuestions.length;

      // Quiz is rendered inside chat view
      showView('chat');

      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      hasReplies = true;
      if (explainBackSection) {
        explainBackSection.style.display = 'block';
      }

      let currentQuestionIndex = 0;
      let score = 0;
      const byConcept = {};
      const missedConcepts = [];
      let isAnswered = false;

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'quiz-card';
      row.appendChild(card);
      messagesContainer.appendChild(row);

      function renderCurrentQuestion() {
        card.innerHTML = '';
        isAnswered = false;

        const q = quizQuestions[currentQuestionIndex];

        // 1. Header: "Quiz · Question N of totalQuestions" and progress text label
        const header = document.createElement('div');
        header.className = 'quiz-header';

        const titleGroup = document.createElement('div');
        titleGroup.className = 'quiz-title-group';
        const iconSpan = document.createElement('span');
        iconSpan.textContent = '🎯';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = 'Quiz · Question ' + (currentQuestionIndex + 1) + ' of ' + totalQuestions;
        titleGroup.appendChild(iconSpan);
        titleGroup.appendChild(titleSpan);
        header.appendChild(titleGroup);

        const progressLabel = document.createElement('span');
        progressLabel.className = 'quiz-progress-label';
        progressLabel.textContent = 'Question ' + (currentQuestionIndex + 1) + ' of ' + totalQuestions;
        header.appendChild(progressLabel);

        card.appendChild(header);

        // 2. Question text (escaped)
        const questionText = document.createElement('div');
        questionText.className = 'quiz-question-text';
        questionText.textContent = q.question;
        card.appendChild(questionText);

        // 3. Optional code block (escaped, in <pre><code>, horizontal scroll)
        if (q.code && typeof q.code === 'string' && q.code.trim()) {
          const pre = document.createElement('pre');
          pre.className = 'quiz-code-block';
          const codeEl = document.createElement('code');
          codeEl.textContent = q.code.trim();
          pre.appendChild(codeEl);
          card.appendChild(pre);
        }

        // 4. Four options as role="radiogroup" with role="radio" and aria-checked
        const optionsGroup = document.createElement('div');
        optionsGroup.className = 'quiz-options-group';
        optionsGroup.setAttribute('role', 'radiogroup');
        optionsGroup.setAttribute('aria-label', 'Answer options');

        const optionEls = [];
        const options = Array.isArray(q.options) ? q.options : [];

        options.forEach(function(optText, optIdx) {
          const optionEl = document.createElement('div');
          optionEl.className = 'quiz-option';
          optionEl.setAttribute('role', 'radio');
          optionEl.setAttribute('aria-checked', 'false');
          optionEl.setAttribute('tabindex', optIdx === 0 ? '0' : '-1');

          const keyBadge = document.createElement('span');
          keyBadge.className = 'quiz-option-key';
          keyBadge.textContent = String(optIdx + 1);

          const textSpan = document.createElement('span');
          textSpan.className = 'quiz-option-text';
          textSpan.textContent = optText;

          optionEl.appendChild(keyBadge);
          optionEl.appendChild(textSpan);

          optionEl.addEventListener('click', function() {
            handleOptionSelect(optIdx);
          });

          optionsGroup.appendChild(optionEl);
          optionEls.push(optionEl);
        });

        card.appendChild(optionsGroup);

        // Feedback & explanation container (revealed on selection)
        const feedbackContainer = document.createElement('div');
        feedbackContainer.className = 'quiz-feedback-container';
        card.appendChild(feedbackContainer);

        // Footer action bar: Skip link + Next/Results button
        const footer = document.createElement('div');
        footer.className = 'quiz-footer-actions';

        const skipLink = document.createElement('button');
        skipLink.type = 'button';
        skipLink.className = 'quiz-skip-link';
        skipLink.textContent = 'Skip quiz';
        skipLink.addEventListener('click', function() {
          cleanupListeners();
          row.remove();
          showView('chat');
          userInput.focus({ preventScroll: true });
        });
        footer.appendChild(skipLink);

        const actionBtnContainer = document.createElement('div');
        actionBtnContainer.className = 'quiz-action-btn-container';
        footer.appendChild(actionBtnContainer);

        card.appendChild(footer);

        // Keyboard navigation across options: Arrow keys, Enter/Space, number keys 1-4
        let focusedIndex = 0;
        function handleKeyDown(e) {
          if (isAnswered) return;

          if (e.key >= '1' && e.key <= '4') {
            const chosen = parseInt(e.key, 10) - 1;
            if (chosen < optionEls.length) {
              e.preventDefault();
              handleOptionSelect(chosen);
              return;
            }
          }

          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            optionEls[focusedIndex].setAttribute('tabindex', '-1');
            focusedIndex = (focusedIndex + 1) % optionEls.length;
            optionEls[focusedIndex].setAttribute('tabindex', '0');
            optionEls[focusedIndex].focus();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            optionEls[focusedIndex].setAttribute('tabindex', '-1');
            focusedIndex = (focusedIndex - 1 + optionEls.length) % optionEls.length;
            optionEls[focusedIndex].setAttribute('tabindex', '0');
            optionEls[focusedIndex].focus();
          } else if (e.key === 'Enter' || e.key === ' ') {
            if (document.activeElement && optionEls.includes(document.activeElement)) {
              e.preventDefault();
              handleOptionSelect(focusedIndex);
            }
          }
        }

        function cleanupListeners() {
          document.removeEventListener('keydown', handleKeyDown);
        }

        document.addEventListener('keydown', handleKeyDown);

        function handleOptionSelect(chosenIndex) {
          if (isAnswered) return;
          isAnswered = true;
          cleanupListeners();

          const isCorrect = (chosenIndex === q.answer_index);
          const conceptName = q.concept || 'General';

          byConcept[conceptName] = byConcept[conceptName] || { correct: 0, total: 0 };
          byConcept[conceptName].total++;

          if (isCorrect) {
            score++;
            byConcept[conceptName].correct++;
          } else {
            missedConcepts.push(conceptName);
          }

          // Lock options and update visual feedback
          optionEls.forEach(function(el, i) {
            el.classList.add('locked');
            el.setAttribute('tabindex', '-1');
            if (i === chosenIndex) {
              el.setAttribute('aria-checked', 'true');
              if (isCorrect) {
                el.classList.add('selected-correct');
              } else {
                el.classList.add('selected-incorrect');
              }
            } else if (i === q.answer_index && !isCorrect) {
              el.classList.add('reveal-correct');
            }
          });

          // Show feedback box: text label ("✓ Correct" or "✕ Not quite") + explanation
          const feedbackBox = document.createElement('div');
          feedbackBox.className = 'quiz-feedback-box ' + (isCorrect ? 'correct' : 'incorrect');

          const statusLabel = document.createElement('div');
          statusLabel.className = 'quiz-feedback-status ' + (isCorrect ? 'correct' : 'incorrect');
          statusLabel.textContent = isCorrect ? '✓ Correct!' : '✕ Not quite';
          feedbackBox.appendChild(statusLabel);

          if (!isCorrect && typeof q.answer_index === 'number' && options[q.answer_index]) {
            const correctInfo = document.createElement('div');
            correctInfo.className = 'quiz-feedback-correct-answer';
            correctInfo.textContent = 'Correct answer: ' + options[q.answer_index];
            feedbackBox.appendChild(correctInfo);
          }

          if (q.explanation && typeof q.explanation === 'string' && q.explanation.trim()) {
            const explanationEl = document.createElement('div');
            explanationEl.className = 'quiz-explanation-text';
            explanationEl.textContent = q.explanation.trim();
            feedbackBox.appendChild(explanationEl);
          }

          feedbackContainer.appendChild(feedbackBox);

          // Navigation button: Next or See results (dynamic for totalQuestions)
          const isLastQuestion = (currentQuestionIndex === totalQuestions - 1);
          const nextBtn = document.createElement('button');
          nextBtn.type = 'button';
          nextBtn.className = 'btn-action';
          nextBtn.textContent = isLastQuestion ? 'See results →' : 'Next →';
          nextBtn.addEventListener('click', function() {
            if (isLastQuestion) {
              renderResultsCard();
            } else {
              currentQuestionIndex++;
              renderCurrentQuestion();
            }
          });

          actionBtnContainer.appendChild(nextBtn);
          nextBtn.focus();
          scrollToBottom(true);
        }

        scrollToBottom(false);
      }

      function renderResultsCard() {
        card.innerHTML = '';

        const resultsHeader = document.createElement('div');
        resultsHeader.className = 'quiz-results-header';
        resultsHeader.innerHTML = '<span>🏆</span><span>You got ' + score + ' of ' + totalQuestions + '</span>';
        card.appendChild(resultsHeader);

        let sentence = '';
        if (score === totalQuestions) {
          sentence = "Outstanding work! You've mastered all the concepts covered in this quiz.";
        } else if (score >= totalQuestions - 1) {
          sentence = "Great progress! You have a solid grasp on these concepts with just a little review needed.";
        } else {
          sentence = "Good effort! Taking quizzes helps lock in what you've learned. Review the concepts below to build your confidence.";
        }

        const sentenceEl = document.createElement('div');
        sentenceEl.className = 'quiz-results-sentence';
        sentenceEl.textContent = sentence;
        card.appendChild(sentenceEl);

        const uniqueMissed = Array.from(new Set(missedConcepts));
        if (uniqueMissed.length > 0) {
          const revisitSec = document.createElement('div');
          revisitSec.className = 'quiz-revisit-section';

          const revisitLabel = document.createElement('div');
          revisitLabel.className = 'quiz-revisit-label';
          revisitLabel.textContent = 'Concepts to revisit:';
          revisitSec.appendChild(revisitLabel);

          const chipsWrap = document.createElement('div');
          chipsWrap.className = 'quiz-revisit-chips';

          uniqueMissed.forEach(function(concept) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'quiz-revisit-chip';
            chip.textContent = '↻ ' + concept;
            chip.title = 'Ask for practice on ' + concept;
            chip.addEventListener('click', function() {
              showView('chat');
              userInput.value = 'Can you give me a practice exercise on ' + concept + '?';
              userInput.focus({ preventScroll: true });
              scrollToBottom(true);
            });
            chipsWrap.appendChild(chip);
          });

          revisitSec.appendChild(chipsWrap);
          card.appendChild(revisitSec);
        }

        const actions = document.createElement('div');
        actions.className = 'quiz-results-actions';

        const retakeBtn = document.createElement('button');
        retakeBtn.type = 'button';
        retakeBtn.className = 'btn-action';
        retakeBtn.textContent = 'Retake with new questions';
        retakeBtn.addEventListener('click', function() {
          showView('chat');
          vscode.postMessage({ type: 'startQuiz' });
        });
        actions.appendChild(retakeBtn);

        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'cancel-btn';
        backBtn.textContent = 'Back to chat';
        backBtn.addEventListener('click', function() {
          showView('chat');
          userInput.focus({ preventScroll: true });
          scrollToBottom(true);
        });
        actions.appendChild(backBtn);

        // If perfect score, offer harder quiz
        if (score === totalQuestions) {
          const harderBtn = document.createElement('button');
          harderBtn.type = 'button';
          harderBtn.className = 'btn-action';
          harderBtn.textContent = 'Nice work. Want something harder?';
          harderBtn.title = 'Start intermediate level quiz';
          harderBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'startQuiz', forceIntermediate: true });
          });
          actions.appendChild(harderBtn);
        }

        card.appendChild(actions);

        // Post completed quiz evidence to extension host
        vscode.postMessage({
          type: 'quizCompleted',
          result: {
            total: totalQuestions,
            correct: score,
            byConcept: byConcept,
            missedConcepts: uniqueMissed
          }
        });

        scrollToBottom(true);
      }

      // Start by rendering Question 1
      renderCurrentQuestion();
    }
  `;
}
