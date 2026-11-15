# Os principais papéis e suas atribuições são:

> **Nota (2026-11-14).** Este texto é o registro das ideias iniciais do dono e não foi reescrito. A referência é a [arquitetura](arquitetura.md) v0.32 e o [fluxo da peça](fluxo-da-peca.md). Quando divergirem, vale a arquitetura.
>
> O que mudou:
> - Cada papel tem uma fronteira estreita, com o que faz e o que não faz (P13 e §5.4).
> - Produtor: também responde às dúvidas do plano (§5.4).
> - Autor: declara dúvidas e suposições e revisa todo roteiro. Não divide em demandas nem escreve código (§5.4).
> - Revisor: julga também as suposições e não reescreve o plano (§5.4).
> - Roteirista: entrega demandas prontas, com `verify`, e não muda o plano (§5.4).
> - Diretor: é o mesmo papel do Orquestrador. Não planeja, não divide nem escreve código, e só decide nos pontos de julgamento com schema. A entrega segue `delivery.mode`, com PR por padrão (§5.4, §5.5 e §13).
> - Atores: escrevem o código de uma demanda pronta, com as cascas e os plugins do papel, e podem encerrar como `blocked`. O tempo limite é o `demand_timeout`, com teto (§5.3, §5.4 e §5.8).
> - Crítico: avalia o trabalho integrado e não corrige (§5.4).
> - Papel novo: o Consultor, que o Diretor do chat abre quando a pergunta pede (§5.20).
> - Os papéis têm nome canônico em inglês (§5.22 e §13).

* **Produtor:** Define o escopo inicial e a necessidade do projeto (ex: nova funcionalidade, correção de *bugs*, análise de dados), atuando como o ponto de entrada do sistema.


* **Autor:** Atua como agente planejador, recebendo a demanda do Produtor para montar um plano de ação detalhado e lógico. Trabalha no modo de planejamento.

 
* **Revisor:** Valida o plano do Autor, garantindo que atende à necessidade do Produtor sem falhas lógicas ou omissões antes de consumir recursos.


* **Roteirista:** Divide o plano em tarefas executáveis, define o que pode ser processado em paralelo ou em sequência e cria contratos de interface rígidos entre as tarefas.


* **Diretor:** É o orquestrador principal do sistema. Ele distribui as tarefas do roteiro, monitora a execução, gerencia as decisões de *merge* (integração do código) ou roteia os ciclos de correção e escalonamento de erros de acordo com o parecer de qualidade.


* **Atores:** São os agentes especializados (*workers*) que recebem as tarefas do Diretor e trabalham de forma independente em *branches* e worktree separadas. Eles utilizam as ferramentas necessárias (Skills, MCPs) e possuem um limite de tempo para execução.


* **Crítico:** Age como avaliador de qualidade (QA), inspecionando o trabalho combinado dos Atores para garantir aderência ao *prompt* original, testes automatizados e coesão do código.