# Os principais papéis e suas atribuições são:

* **Produtor:** Define o escopo inicial e a necessidade do projeto (ex: nova funcionalidade, correção de *bugs*, análise de dados), atuando como o ponto de entrada do sistema.


* **Autor:** Atua como agente planejador, recebendo a demanda do Produtor para montar um plano de ação detalhado e lógico. Trabalha no modo de planejamento.

 
* **Revisor:** Valida o plano do Autor, garantindo que atende à necessidade do Produtor sem falhas lógicas ou omissões antes de consumir recursos.


* **Roteirista:** Divide o plano em tarefas executáveis, define o que pode ser processado em paralelo ou em sequência e cria contratos de interface rígidos entre as tarefas.


* **Diretor:** É o orquestrador principal do sistema. Ele distribui as tarefas do roteiro, monitora a execução, gerencia as decisões de *merge* (integração do código) ou roteia os ciclos de correção e escalonamento de erros de acordo com o parecer de qualidade.


* **Atores:** São os agentes especializados (*workers*) que recebem as tarefas do Diretor e trabalham de forma independente em *branches* e worktree separadas. Eles utilizam as ferramentas necessárias (Skills, MCPs) e possuem um limite de tempo para execução.


* **Crítico:** Age como avaliador de qualidade (QA), inspecionando o trabalho combinado dos Atores para garantir aderência ao *prompt* original, testes automatizados e coesão do código.